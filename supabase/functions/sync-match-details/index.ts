import { createClient } from "npm:@supabase/supabase-js@2";

const env = (name: string) => Deno.env.get(name)?.trim() ?? "";
const PROJECT_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const API_KEY = env("API_FOOTBALL_KEY");
const SYNC_SECRET = env("SYNC_FUNCTION_SECRET");
const API = "https://v3.football.api-sports.io";
const TZ = "Europe/Madrid";
const DAILY_API_LIMIT = 7;
const LEAGUES = new Set([140, 39, 78, 135, 2, 3, 848]);
const FINAL_STATUSES = new Set(["FT", "AET", "PEN"]);
const RETRY_EMPTY_AFTER_HOURS = 72;

type MatchRow = {
  id: number;
  competid_id: string;
  fecha_utc: string;
  estadisticas_estado: string;
  estadisticas_confirmada_at: string | null;
  eventos_estado: string;
  eventos_confirmados_at: string | null;
  equipo_local?: { nombre?: string } | null;
  equipo_visitante?: { nombre?: string } | null;
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function madridDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
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

function normalizeTeam(value: unknown): string {
  let name = String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/\b(fc|cf|afc|sc|ac|as|ssc|club|the)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  const aliases: Record<string, string> = {
    "bayern munchen": "bayern", "bayern munich": "bayern",
    "1 fc koln": "koln", "1 koln": "koln", "fc koln": "koln", "cologne": "koln",
    "paris saint germain": "psg", "paris sg": "psg",
    "manchester united": "man utd", "man utd": "man utd",
    "manchester city": "man city", "man city": "man city",
    "internazionale": "inter", "inter milan": "inter",
    "ac milan": "milan",
    "atletico de madrid": "atletico madrid",
    "real madrid cf": "real madrid", "fc barcelona": "barcelona",
    "rcd espanyol de barcelona": "espanyol", "espanyol barcelona": "espanyol",
    "athletic bilbao": "athletic",
    "brighton and hove albion": "brighton",
    "wolverhampton wanderers": "wolves",
    "newcastle united": "newcastle", "tottenham hotspur": "tottenham",
    "west ham united": "west ham", "leeds united": "leeds",
    "afc bournemouth": "bournemouth",
    "bayer 04 leverkusen": "leverkusen",
    "borussia monchengladbach": "monchengladbach",
    "borussia dortmund": "dortmund",
    "real betis balompie": "betis", "real betis": "betis",
    "valencia cf": "valencia", "celta vigo": "celta",
    "deportivo alaves": "alaves", "girona fc": "girona",
    "rcd mallorca": "mallorca", "getafe cf": "getafe",
    "sevilla fc": "sevilla",
  };
  return aliases[name] ?? name;
}

function findMatch(rows: MatchRow[], fixture: any): MatchRow | null {
  const leagueId = String(fixture?.league?.id ?? "");
  const kickoff = new Date(fixture?.fixture?.date ?? "").getTime();
  if (!Number.isFinite(kickoff)) return null;
  const home = normalizeTeam(fixture?.teams?.home?.name);
  const away = normalizeTeam(fixture?.teams?.away?.name);
  const candidates = rows.filter((row) => {
    if (row.competid_id !== leagueId) return false;
    const rowKickoff = new Date(row.fecha_utc).getTime();
    return Number.isFinite(rowKickoff) &&
      Math.abs(rowKickoff - kickoff) <= 8 * 60 * 60 * 1000 &&
      normalizeTeam(row.equipo_local?.nombre) === home &&
      normalizeTeam(row.equipo_visitante?.nombre) === away;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function statValue(items: any[], label: string): number | null {
  const item = items.find((entry) => String(entry?.type ?? "").toLowerCase() === label.toLowerCase());
  return numberValue(item?.value);
}

function eventKey(event: any, index: number): string {
  return [
    index, event?.time?.elapsed ?? "", event?.time?.extra ?? "",
    event?.team?.id ?? "", event?.player?.id ?? "", event?.assist?.id ?? "",
    event?.type ?? "", event?.detail ?? "", event?.comments ?? "",
  ].join("|");
}

function shouldRetry(status: string, confirmedAt: string | null, now: number): boolean {
  if (status === "AVAILABLE" || status === "PENDING") return true;
  if (!confirmedAt) return true;
  const confirmed = new Date(confirmedAt).getTime();
  return !Number.isFinite(confirmed) || now - confirmed >= RETRY_EMPTY_AFTER_HOURS * 3600000;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (!SYNC_SECRET || request.headers.get("x-sync-secret") !== SYNC_SECRET) return reply({ error: "unauthorized" }, 401);
  if (!PROJECT_URL || !SERVICE_KEY || !API_KEY) return reply({ error: "missing_function_secrets" }, 500);

  const db = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: run, error: runError } = await db.from("match_details_sync_runs")
    .insert({ status: "running" }).select("id").single();
  if (runError || !run) return reply({ error: "could_not_start_run", detail: runError?.message }, 500);

  let apiRequests = 0;
  let fixturesSeen = 0;
  let fixturesEnriched = 0;
  let statisticsSaved = 0;
  let eventsSaved = 0;
  const outcomes: Record<string, unknown>[] = [];

  try {
    const now = new Date();
    const [year, month, day] = madridDate(now).split("-").map(Number);
    const offsetLabel = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
      .formatToParts(now).find((part) => part.type === "timeZoneName")?.value ?? "GMT+0";
    const offsetMatch = offsetLabel.match(/GMT([+-])(\\d{1,2})(?::(\\d{2}))?/);
    const offsetMinutes = offsetMatch
      ? (offsetMatch[1] === "-" ? -1 : 1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3] ?? 0))
      : 0;
    const dayStart = new Date(Date.UTC(year, month - 1, day) - offsetMinutes * 60000).toISOString();
    const { data: previousRuns, error: usageError } = await db.from("match_details_sync_runs")
      .select("api_requests").gte("started_at", dayStart);
    if (usageError) throw new Error("No se pudo comprobar el límite diario: " + usageError.message);
    const usedToday = (previousRuns ?? []).reduce((sum: number, row: any) => sum + Number(row.api_requests ?? 0), 0);
    const remaining = Math.max(0, DAILY_API_LIMIT - usedToday);
    if (remaining < 1) {
      await db.from("match_details_sync_runs").update({
        status: "skipped", finished_at: new Date().toISOString(),
        details: { reason: "daily_api_limit_reached", used_today: usedToday, daily_limit: DAILY_API_LIMIT },
      }).eq("id", run.id);
      return reply({ ok: true, skipped: true, used_today: usedToday, daily_limit: DAILY_API_LIMIT });
    }

    const datesToCheck = [1, 0].map((daysAgo) =>
      madridDate(new Date(now.getTime() - daysAgo * 86400000))
    ).slice(0, Math.min(3, Math.max(0, remaining - 1)));
    const fixtureMap = new Map<number, any>();
    for (const date of datesToCheck) {
      apiRequests++;
      const dateData = await apiGet("/fixtures?date=" + date + "&timezone=" + TZ);
      const dateFixtures = Array.isArray(dateData.response) ? dateData.response : [];
      for (const fixture of dateFixtures) {
        const fixtureId = Number(fixture?.fixture?.id);
        if (fixtureId && LEAGUES.has(Number(fixture?.league?.id)) &&
          FINAL_STATUSES.has(String(fixture?.fixture?.status?.short ?? ""))) {
          fixtureMap.set(fixtureId, fixture);
        }
      }
    }
    const fixtures = [...fixtureMap.values()]
      .sort((a: any, b: any) => new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime());
    const from = datesToCheck.at(-1) ?? madridDate(now);
    const to = datesToCheck[0] ?? madridDate(now);
    fixturesSeen = fixtures.length;

    const windowStart = new Date(now.getTime() - 8 * 86400000).toISOString();
    const { data: matches, error: matchesError } = await db.from("partidos")
      .select("id,competid_id,fecha_utc,estadisticas_estado,estadisticas_confirmada_at,eventos_estado,eventos_confirmados_at,equipo_local:equipos!partidos_equipo_local_id_fkey(nombre),equipo_visitante:equipos!partidos_equipo_visitante_id_fkey(nombre)")
      .eq("estado", "FINISHED").in("competid_id", [...LEAGUES].map(String))
      .gte("fecha_utc", windowStart).lte("fecha_utc", now.toISOString());
    if (matchesError) throw new Error("No se pudieron cargar partidos de Supabase: " + matchesError.message);
    const rows = (matches ?? []) as MatchRow[];
    const candidates = fixtures.map((fixture: any) => ({ fixture, match: findMatch(rows, fixture) }))
      .filter((entry: any) => entry.match)
      .filter((entry: any) => {
        const match = entry.match as MatchRow;
        return shouldRetry(match.estadisticas_estado, match.estadisticas_confirmada_at, now.getTime()) ||
          shouldRetry(match.eventos_estado, match.eventos_confirmados_at, now.getTime());
      });

    const maxDetailBatches = Math.max(0, remaining - datesToCheck.length);
    const detailBatches: any[][] = [];
    for (let index = 0; index < candidates.length; index += 20) {
      detailBatches.push(candidates.slice(index, index + 20));
    }
    for (const batch of detailBatches.slice(0, maxDetailBatches)) {
      let detailById = new Map<number, any>();
      try {
        apiRequests++;
        const ids = batch.map((entry: any) => Number(entry.fixture.fixture.id)).join("-");
        const detailData = await apiGet("/fixtures?ids=" + ids);
        const details = Array.isArray(detailData.response) ? detailData.response : [];
        detailById = new Map(details.map((detail: any) => [Number(detail?.fixture?.id), detail]));
      } catch (error) {
        for (const entry of batch) {
          outcomes.push({
            fixture_id: Number(entry.fixture.fixture.id),
            match_id: entry.match.id,
            status: "detail_batch_error",
            error: String(error).slice(0, 250),
          });
        }
        continue;
      }

      for (const entry of batch) {
        const fixture = entry.fixture;
        const match = entry.match as MatchRow;
        const fixtureId = Number(fixture.fixture.id);
        try {
          const detail = detailById.get(fixtureId) ?? null;
          if (!detail) {
            outcomes.push({ fixture_id: fixtureId, match_id: match.id, status: "empty_fixture_detail" });
            continue;
          }

        const teamStats = Array.isArray(detail.statistics) ? detail.statistics : [];
        const homeBlock = teamStats.find((block: any) => Number(block?.team?.id) === Number(detail.teams?.home?.id)) ?? null;
        const awayBlock = teamStats.find((block: any) => Number(block?.team?.id) === Number(detail.teams?.away?.id)) ?? null;
        const homeStats = Array.isArray(homeBlock?.statistics) ? homeBlock.statistics : [];
        const awayStats = Array.isArray(awayBlock?.statistics) ? awayBlock.statistics : [];
        const statsRow = {
          partido_id: match.id,
          posesion_local: statValue(homeStats, "Ball Possession"),
          posesion_visitante: statValue(awayStats, "Ball Possession"),
          tiros_puerta_local: statValue(homeStats, "Shots on Goal"),
          tiros_puerta_visitante: statValue(awayStats, "Shots on Goal"),
          tiros_totales_local: statValue(homeStats, "Total Shots"),
          tiros_totales_visitante: statValue(awayStats, "Total Shots"),
          tiros_fuera_local: statValue(homeStats, "Shots off Goal"),
          tiros_fuera_visitante: statValue(awayStats, "Shots off Goal"),
          tiros_bloqueados_local: statValue(homeStats, "Blocked Shots"),
          tiros_bloqueados_visitante: statValue(awayStats, "Blocked Shots"),
          corners_local: statValue(homeStats, "Corner Kicks"),
          corners_visitante: statValue(awayStats, "Corner Kicks"),
          faltas_local: statValue(homeStats, "Fouls"),
          faltas_visitante: statValue(awayStats, "Fouls"),
          fueras_juego_local: statValue(homeStats, "Offsides"),
          fueras_juego_visitante: statValue(awayStats, "Offsides"),
          paradas_portero_local: statValue(homeStats, "Goalkeeper Saves"),
          paradas_portero_visitante: statValue(awayStats, "Goalkeeper Saves"),
          pases_totales_local: statValue(homeStats, "Total passes"),
          pases_totales_visitante: statValue(awayStats, "Total passes"),
          pases_precisos_local: statValue(homeStats, "Passes accurate"),
          pases_precisos_visitante: statValue(awayStats, "Passes accurate"),
          precision_pases_local: statValue(homeStats, "Passes %"),
          precision_pases_visitante: statValue(awayStats, "Passes %"),
          tarjetas_amarillas_local: statValue(homeStats, "Yellow Cards"),
          tarjetas_amarillas_visitante: statValue(awayStats, "Yellow Cards"),
          tarjetas_rojas_local: statValue(homeStats, "Red Cards"),
          tarjetas_rojas_visitante: statValue(awayStats, "Red Cards"),
          fuente: "API-Football",
          capturado_at: new Date().toISOString(),
          raw_payload: { fixture_id: fixtureId, statistics: teamStats },
        };
        const statValues = Object.entries(statsRow).filter(([key, value]) =>
          key !== "partido_id" && key !== "fuente" && key !== "capturado_at" && key !== "raw_payload" && value !== null
        );
        let hasStats = statValues.length > 0;
        if (hasStats) {
          const { data: existingStat, error: existingStatError } = await db.from("estadisticas_partido")
            .select("id,fuente").eq("partido_id", match.id).maybeSingle();
          if (existingStatError) throw new Error("Lectura de estadísticas: " + existingStatError.message);
          if (!existingStat || existingStat.fuente === "API-Football") {
            const { error } = await db.from("estadisticas_partido").upsert(statsRow, { onConflict: "partido_id" });
            if (error) throw new Error("Guardado de estadísticas: " + error.message);
            statisticsSaved++;
          } else {
            hasStats = true;
          }
        }

        const events = Array.isArray(detail.events) ? detail.events : [];
        const eventRows = events.map((event: any, index: number) => ({
          partido_id: match.id,
          proveedor: "API-Football",
          fixture_id: fixtureId,
          event_key: eventKey(event, index),
          minuto: Number.isInteger(event?.time?.elapsed) ? event.time.elapsed : null,
          minuto_extra: Number.isInteger(event?.time?.extra) ? event.time.extra : null,
          equipo: event?.team?.name ?? null,
          lado_equipo: Number(event?.team?.id) === Number(detail.teams?.home?.id) ? "local" :
            Number(event?.team?.id) === Number(detail.teams?.away?.id) ? "visitante" : "unknown",
          jugador_id: Number.isInteger(event?.player?.id) ? event.player.id : null,
          jugador: event?.player?.name ?? null,
          asistente_id: Number.isInteger(event?.assist?.id) ? event.assist.id : null,
          asistente: event?.assist?.name ?? null,
          tipo: event?.type ?? null,
          detalle: event?.detail ?? null,
          comentario: event?.comments ?? null,
          raw_payload: event,
          capturado_at: new Date().toISOString(),
        }));
        if (eventRows.length) {
          const { error } = await db.from("partido_eventos").upsert(eventRows, {
            onConflict: "partido_id,proveedor,event_key",
          });
          if (error) throw new Error("Guardado de eventos: " + error.message);
          eventsSaved += eventRows.length;
        }

        const confirmedAt = new Date().toISOString();
        const { error: matchUpdateError } = await db.from("partidos").update({
          estadisticas_estado: hasStats ? "AVAILABLE" : "EMPTY_RESPONSE",
          estadisticas_primera_captura_at: match.estadisticas_confirmada_at ?? confirmedAt,
          estadisticas_confirmada_at: confirmedAt,
          eventos_estado: events.length ? "AVAILABLE" : "EMPTY_RESPONSE",
          eventos_confirmados_at: confirmedAt,
        }).eq("id", match.id);
        if (matchUpdateError) throw new Error("Actualización del estado del partido: " + matchUpdateError.message);
        fixturesEnriched++;
        outcomes.push({
          fixture_id: fixtureId, match_id: match.id, league_id: fixture.league.id,
          statistics: hasStats ? "saved_or_existing" : "not_covered_or_empty",
          events: events.length, status: "processed",
        });
        } catch (error) {
          outcomes.push({ fixture_id: fixtureId, match_id: match.id, status: "error", error: String(error).slice(0, 300) });
        }
      }
    }

    const partial = outcomes.some((item) =>
      item.status === "error" || item.status === "detail_batch_error"
    );
    const { error: finishError } = await db.from("match_details_sync_runs").update({
      finished_at: new Date().toISOString(),
      status: partial ? "partial" : "success",
      api_requests: apiRequests,
      fixtures_seen: fixturesSeen,
      fixtures_enriched: fixturesEnriched,
      statistics_saved: statisticsSaved,
      events_saved: eventsSaved,
      details: { from, to, daily_api_limit: DAILY_API_LIMIT, used_before_run: usedToday, remaining_before_run: remaining, outcomes },
    }).eq("id", run.id);
    if (finishError) return reply({ error: "could_not_finish_run", detail: finishError.message }, 500);
    return reply({
      ok: true, api_requests: apiRequests, daily_limit: DAILY_API_LIMIT,
      fixtures_seen: fixturesSeen, fixtures_enriched: fixturesEnriched,
      statistics_saved: statisticsSaved, events_saved: eventsSaved, outcomes,
    });
  } catch (error) {
    await db.from("match_details_sync_runs").update({
      finished_at: new Date().toISOString(), status: "failed", api_requests: apiRequests,
      details: { error: String(error).slice(0, 500), outcomes },
    }).eq("id", run.id);
    return reply({ error: String(error).slice(0, 500), api_requests: apiRequests }, 500);
  }
});
