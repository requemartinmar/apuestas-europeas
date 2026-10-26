import { createClient } from "npm:@supabase/supabase-js@2";

/** Resultados reales de football-data.org Free; no ofrece estadísticas de partido. */
const PROVIDER = "football-data.org";
const API_ROOT = "https://api.football-data.org/v4";
// IDs internos conservados para que el frontend existente siga funcionando.
const COMPETITIONS = [
  { id: "140", code: "PD", name: "LaLiga", country: "España" },
  { id: "39", code: "PL", name: "Premier League", country: "Inglaterra" },
  { id: "78", code: "BL1", name: "Bundesliga", country: "Alemania" },
  { id: "135", code: "SA", name: "Serie A", country: "Italia" },
  { id: "2", code: "CL", name: "UEFA Champions League", country: "Europa" },
];
// Namespaced IDs prevent collisions with records created by the old API-Football adapter.
const MATCH_ID_OFFSET = 8_000_000_000_000_000;
const TEAM_ID_OFFSET = 7_000_000_000_000_000;
type Team = { id: number; name: string; shortName?: string | null; tla?: string | null; crest?: string | null };
type Match = {
  id: number;
  utcDate: string;
  status: string;
  matchday?: number | null;
  stage?: string | null;
  homeTeam: Team;
  awayTeam: Team;
  score?: { fullTime?: { home: number | null; away: number | null } };
};
type MatchEnvelope = { matches?: Match[]; message?: string; resultSet?: { count?: number } };

const env = (key: string) => Deno.env.get(key)?.trim() ?? "";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const seasonLabel = (year: number) => `${year}/${String(year + 1).slice(-2)}`;
const seasonStartYear = (now = new Date()) => now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const internalId = (offset: number, id: number) => offset + id;

function normalizedStatus(status: string): string {
  if (status === "FINISHED") return "FINISHED";
  if (["IN_PLAY", "PAUSED", "LIVE", "SUSPENDED"].includes(status)) return "LIVE";
  if (status === "POSTPONED") return "POSTPONED";
  if (["CANCELLED", "AWARDED"].includes(status)) return "NOT_PLAYED";
  return "SCHEDULED";
}

function roundLabel(match: Match): string {
  if (match.matchday) return `Jornada ${match.matchday}`;
  return String(match.stage ?? "Ronda sin etiqueta").replaceAll("_", " ");
}

async function fetchMatches(code: string, year: number, token: string, from: string, to: string) {
  const url = new URL(`${API_ROOT}/competitions/${code}/matches`);
  url.searchParams.set("season", String(year));
  url.searchParams.set("dateFrom", from);
  url.searchParams.set("dateTo", to);
  const response = await fetch(url, { headers: { "X-Auth-Token": token } });
  const body = await response.json() as MatchEnvelope;
  if (!response.ok) {
    const detail = body.message ?? `HTTP ${response.status}`;
    throw new Error(`football-data.org ${code}: ${detail}`);
  }
  return body.matches ?? [];
}

async function upsertTeam(db: ReturnType<typeof createClient>, team: Team, competitionId: string, season: string) {
  const id = internalId(TEAM_ID_OFFSET, team.id);
  const { error } = await db.from("equipos").upsert({
    id,
    nombre: team.name,
    nombre_corto: team.tla ?? team.shortName ?? null,
    escudo_url: team.crest ?? null,
  }, { onConflict: "id" });
  if (error) throw error;
  const { error: linkError } = await db.from("equipo_competiciones").upsert({
    equipo_id: id,
    competicion_id: competitionId,
    temporada: season,
  }, { onConflict: "equipo_id,competicion_id,temporada" });
  if (linkError) throw linkError;
  return id;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const syncSecret = env("SYNC_FUNCTION_SECRET");
  if (!syncSecret || request.headers.get("x-sync-secret") !== syncSecret) return reply({ error: "unauthorized" }, 401);

  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const token = env("FOOTBALL_DATA_API_TOKEN");
  if (!supabaseUrl || !serviceKey || !token) return reply({ error: "missing_function_secrets", required: ["FOOTBALL_DATA_API_TOKEN"] }, 500);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const year = Number(env("FOOTBALL_SEASON") || seasonStartYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return reply({ error: "invalid_FOOTBALL_SEASON" }, 500);
  const season = seasonLabel(year);
  const { data: run, error: runError } = await db.from("sincronizaciones").insert({
    proveedor: PROVIDER, temporada: season, tipo: "JORNADA_ACTUAL", estado: "RUNNING",
  }).select("id").single();
  if (runError) return reply({ error: "sync_log_insert_failed", detail: runError.message }, 500);

  const now = new Date();
  const fromDate = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  // dateTo is exclusive in football-data.org v4.
  const toDate = new Date(now.getTime() + 15 * 86400000).toISOString().slice(0, 10);
  const outcomes: Array<Record<string, unknown>> = [];
  try {
    for (const competition of COMPETITIONS) {
      let matchesSeen = 0;
      let matchesSaved = 0;
      try {
        const matches = await fetchMatches(competition.code, year, token, fromDate, toDate);
        matchesSeen = matches.length;
        const { error: compError } = await db.from("competiciones").upsert({
          id: competition.id,
          nombre: competition.name,
          pais: competition.country,
          temporada_actual: season,
          activo: true,
        }, { onConflict: "id" });
        if (compError) throw compError;

        for (const match of matches) {
          const homeId = await upsertTeam(db, match.homeTeam, competition.id, season);
          const awayId = await upsertTeam(db, match.awayTeam, competition.id, season);
          const matchId = internalId(MATCH_ID_OFFSET, match.id);
          const label = roundLabel(match);
          const { error } = await db.from("partidos").upsert({
            id: matchId,
            competid_id: competition.id,
            temporada: season,
            jornada: match.matchday ?? 0,
            jornada_nombre: label,
            fecha_utc: match.utcDate,
            equipo_local_id: homeId,
            equipo_visitante_id: awayId,
            goles_local: match.score?.fullTime?.home ?? null,
            goles_visitante: match.score?.fullTime?.away ?? null,
            estado: normalizedStatus(match.status),
            fuente: PROVIDER,
            sincronizado_at: new Date().toISOString(),
            raw_payload: match,
            // Este proveedor Free no entrega estadísticas de partido.
            estadisticas_estado: normalizedStatus(match.status) === "FINISHED" ? "EMPTY_RESPONSE" : "PENDING",
          }, { onConflict: "id" });
          if (error) throw error;
          matchesSaved++;
        }
        outcomes.push({ competicion: competition.code, estado: "SUCCESS", partidos_vistos: matchesSeen, partidos_guardados: matchesSaved });
      } catch (error) {
        outcomes.push({ competicion: competition.code, estado: "FAILED", error: String(error).slice(0, 350) });
      }
    }

    // Mantener desactivadas las dos competiciones no incluidas en el nivel gratuito.
    for (const [id, name] of [["3", "UEFA Europa League"], ["848", "UEFA Conference League"]]) {
      const { error } = await db.from("competiciones").upsert({ id, nombre: name, pais: "Europa", temporada_actual: season, activo: false }, { onConflict: "id" });
      if (error) outcomes.push({ competicion: id, estado: "FAILED", error: error.message });
      else outcomes.push({ competicion: id, estado: "UNAVAILABLE_FREE_TIER" });
    }

    const partial = outcomes.some((item) => item.estado === "FAILED");
    const totals = outcomes.reduce((sum, item) => ({
      vistos: sum.vistos + Number(item.partidos_vistos ?? 0),
      guardados: sum.guardados + Number(item.partidos_guardados ?? 0),
    }), { vistos: 0, guardados: 0 });
    const { error: finishError } = await db.from("sincronizaciones").update({
      estado: partial ? "PARTIAL" : "SUCCESS",
      terminada_at: new Date().toISOString(),
      partidos_vistos: totals.vistos,
      partidos_guardados: totals.guardados,
      estadisticas_guardadas: 0,
      detalle: { outcomes, fuente: PROVIDER, ventana: { desde: fromDate, hasta_exclusiva: toDate }, nota: "El plan gratuito no incluye estadísticas detalladas." },
    }).eq("id", run.id);
    if (finishError) return reply({ error: "sync_log_update_failed", detail: finishError.message, outcomes }, 500);
    return reply({ temporada: season, fuente: PROVIDER, ventana: { desde: fromDate, hasta_exclusiva: toDate }, outcomes });
  } catch (error) {
    await db.from("sincronizaciones").update({ estado: "FAILED", terminada_at: new Date().toISOString(), error: String(error).slice(0, 500) }).eq("id", run.id);
    return reply({ error: String(error).slice(0, 500) }, 500);
  }
});
