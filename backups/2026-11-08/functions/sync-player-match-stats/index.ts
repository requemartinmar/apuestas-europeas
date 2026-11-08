import { createClient } from "npm:@supabase/supabase-js@2";

const env = (name: string) => Deno.env.get(name)?.trim() ?? "";
const PROJECT_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const API_KEY = env("API_FOOTBALL_KEY");
const SYNC_SECRET = env("SYNC_FUNCTION_SECRET");
const API = "https://v3.football.api-sports.io";
const TZ = "Europe/Madrid";
const LEAGUES = [
  { id: 140, name: "LaLiga" },
  { id: 39, name: "Premier League" },
  { id: 78, name: "Bundesliga" },
  { id: 135, name: "Serie A" },
  { id: 2, name: "Champions League" },
  { id: 3, name: "Europa League" },
  { id: 848, name: "Conference League" },
];
const FINAL_STATUSES = new Set(["FT", "AET", "PEN"]);
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function madridDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function seasonStartYear(date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", year: "numeric" }).formatToParts(date);
  const month = Number(parts.find(p => p.type === "month")?.value ?? 1);
  const year = Number(parts.find(p => p.type === "year")?.value ?? date.getUTCFullYear());
  return month >= 7 ? year : year - 1;
}
async function apiGet(path: string): Promise<any> {
  const response = await fetch(API + path, {
    headers: { "x-apisports-key": API_KEY },
    signal: AbortSignal.timeout(25000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : "HTTP " + response.status;
    throw new Error("API-Football " + message);
  }
  if (body?.errors && Object.keys(body.errors).length) {
    throw new Error("API-Football devolvió errores: " + JSON.stringify(body.errors).slice(0, 300));
  }
  return body;
}
function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return null;
}
function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (!SYNC_SECRET || request.headers.get("x-sync-secret") !== SYNC_SECRET) return reply({ error: "unauthorized" }, 401);
  if (!PROJECT_URL || !SERVICE_KEY || !API_KEY) return reply({ error: "missing_function_secrets", configured: { supabase_url: Boolean(PROJECT_URL), service_role: Boolean(SERVICE_KEY), api_football_key: Boolean(API_KEY), sync_secret: Boolean(SYNC_SECRET) } }, 500);

  const db = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: run, error: runError } = await db.from("player_match_stats_sync_runs")
    .insert({ status: "running" }).select("id").single();
  if (runError || !run) return reply({ error: "could_not_start_run", detail: runError?.message }, 500);

  const now = new Date();
  const fromDate = new Date(now.getTime() - 3 * 86400000);
  const from = madridDate(fromDate);
  const to = madridDate(now);
  const season = seasonStartYear(now);
  const details: Record<string, unknown>[] = [];
  let fixturesChecked = 0;
  let fixturesImported = 0;
  let playersImported = 0;
  let leaguesChecked = 0;

  try {
    for (const league of LEAGUES) {
      try {
        const params = new URLSearchParams({
          league: String(league.id), season: String(season),
          from, to, timezone: TZ,
        });
        const fixtureData = await apiGet("/fixtures?" + params.toString());
        leaguesChecked++;
        const fixtures = Array.isArray(fixtureData.response) ? fixtureData.response : [];
        for (const fixture of fixtures) {
          const fixtureId = asInt(fixture?.fixture?.id);
          const status = String(fixture?.fixture?.status?.short ?? "");
          if (!fixtureId || !FINAL_STATUSES.has(status)) continue;
          fixturesChecked++;

          const { data: existing, error: existingError } = await db.from("player_match_stats")
            .select("player_id,data_quality").eq("provider", "api-football").eq("fixture_id", fixtureId);
          if (existingError) throw new Error("DB lookup fixture " + fixtureId + ": " + existingError.message);
          if (existing?.length && existing.every((row: any) => row.data_quality === "verified")) continue;

          const playerData = await apiGet("/fixtures/players?fixture=" + fixtureId);
          const teams = Array.isArray(playerData.response) ? playerData.response : [];
          const rows: Record<string, unknown>[] = [];
          for (const teamBlock of teams) {
            const teamId = asInt(teamBlock?.team?.id);
            const teamName = String(teamBlock?.team?.name ?? "");
            for (const playerBlock of (Array.isArray(teamBlock?.players) ? teamBlock.players : [])) {
              const playerId = asInt(playerBlock?.player?.id);
              const playerName = String(playerBlock?.player?.name ?? "").trim();
              const stat = Array.isArray(playerBlock?.statistics) ? playerBlock.statistics[0] : null;
              if (!playerId || !playerName || !stat) continue;
              const games = stat.games ?? {};
              const shots = stat.shots ?? {};
              const shotsTotal = asInt(shots.total);
              const shotsOn = asInt(shots.on);
              rows.push({
                provider: "api-football",
                fixture_id: fixtureId,
                league_id: league.id,
                season,
                match_date: fixture.fixture.date,
                home_team: String(fixture.teams?.home?.name ?? ""),
                away_team: String(fixture.teams?.away?.name ?? ""),
                team_id: teamId,
                team_name: teamName,
                player_id: playerId,
                player_name: playerName,
                minutes_played: asInt(games.minutes),
                is_substitute: typeof games.substitute === "boolean" ? games.substitute : null,
                position: typeof games.position === "string" ? games.position : null,
                shots_total: shotsTotal,
                shots_on_target: shotsOn,
                data_quality: shotsTotal !== null && shotsOn !== null ? "verified" : "partial",
                source_status: status,
                raw_payload: playerBlock,
                captured_at: new Date().toISOString(),
              });
            }
          }
          if (rows.length) {
            for (const batch of chunks(rows, 100)) {
              const { error } = await db.from("player_match_stats").upsert(batch, { onConflict: "provider,fixture_id,player_id" });
              if (error) throw new Error("DB upsert fixture " + fixtureId + ": " + error.message);
            }
            fixturesImported++;
            playersImported += rows.length;
            details.push({ league: league.name, fixture_id: fixtureId, status: "imported", players: rows.length,
              verified: rows.filter(r => r.data_quality === "verified").length,
              partial: rows.filter(r => r.data_quality === "partial").length });
          } else {
            details.push({ league: league.name, fixture_id: fixtureId, status: "no_player_stats_yet" });
          }
        }
      } catch (error) {
        details.push({ league: league.name, status: "error", error: String(error).slice(0, 350) });
      }
    }
    const failed = details.some(d => d.status === "error");
    const { error: finishError } = await db.from("player_match_stats_sync_runs").update({
      finished_at: new Date().toISOString(),
      status: failed ? "partial" : "success",
      leagues_checked: leaguesChecked,
      fixtures_checked: fixturesChecked,
      fixtures_imported: fixturesImported,
      players_imported: playersImported,
      details: { from, to, season, outcomes: details },
    }).eq("id", run.id);
    if (finishError) return reply({ error: "could_not_finish_run", detail: finishError.message }, 500);
    return reply({ ok: true, run_id: run.id, leagues_checked: leaguesChecked, fixtures_checked: fixturesChecked,
      fixtures_imported: fixturesImported, players_imported: playersImported, outcomes: details });
  } catch (error) {
    await db.from("player_match_stats_sync_runs").update({
      finished_at: new Date().toISOString(), status: "failed",
      details: { error: String(error).slice(0, 500), outcomes: details },
    }).eq("id", run.id);
    return reply({ error: String(error).slice(0, 500), run_id: run.id }, 500);
  }
});