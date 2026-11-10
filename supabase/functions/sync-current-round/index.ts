import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { MAX_API_FOOTBALL_PAGES, conferenceFixtureHash, conferenceHistoricalId, conferenceNamespacedId, openMatchdayTimeToUtc, stableHash } from "./conference-helpers.ts";

// El cliente usa el esquema público sin tipos generados; evita que ReturnType
// colapse las tablas a never al reutilizarlo en helpers.
type Db = SupabaseClient<any, any, any, any, any>;

/** Sincroniza ligas de football-data.org y Conference League mediante fuentes alternativas. */
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
// Conference usa un subrango separado de los IDs originales del proveedor.
const CONFERENCE_ID_GAP = 1_000_000_000_000;
const CONFERENCE_TEAM_ID_OFFSET = TEAM_ID_OFFSET + CONFERENCE_ID_GAP;
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

async function upsertTeam(db: Db, team: Team, competitionId: string, season: string, idOffset = TEAM_ID_OFFSET) {
  const id = internalId(idOffset, team.id);
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


type ApiFixture = {
  fixture: { id: number; date: string; status: { short: string } };
  league: { round?: string | null };
  teams: { home: Team; away: Team };
  goals: { home: number | null; away: number | null };
};
type ApiFixtureEnvelope = { response?: ApiFixture[]; errors?: Record<string, unknown>; paging?: { current?: number; total?: number }; message?: string };

function apiFixtureStatus(short: string): string {
  if (["FT", "AET", "PEN"].includes(short)) return "FINISHED";
  if (["1H", "HT", "2H", "ET", "BT", "P"].includes(short)) return "LIVE";
  if (["PST", "SUSP"].includes(short)) return "POSTPONED";
  if (["CANC", "ABD", "AWD", "WO"].includes(short)) return "NOT_PLAYED";
  return "SCHEDULED";
}

async function fetchApiFootballPage(year: number, page: number, from?: string, to?: string): Promise<ApiFixtureEnvelope> {
  const key = env("API_FOOTBALL_KEY");
  if (!key) throw new Error("API_FOOTBALL_KEY no configurada");
  const url = new URL("https://v3.football.api-sports.io/fixtures");
  url.searchParams.set("league", "848");
  url.searchParams.set("season", String(year));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("page", String(page));
  if (from) url.searchParams.set("from", from);
  if (to) url.searchParams.set("to", to);
  const response = await fetch(url, {
    headers: { "x-apisports-key": key },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json() as ApiFixtureEnvelope;
  if (!response.ok || (body.errors && Object.keys(body.errors).length)) {
    throw new Error("API-Football Conference " + year + ": " + JSON.stringify(body.errors ?? body.message ?? response.status).slice(0, 250));
  }
  return body;
}

async function fetchApiFootballSeason(year: number, from?: string, to?: string): Promise<ApiFixture[]> {
  const all: ApiFixture[] = [];
  let page = 1;
  let total = 1;
  do {
    const body = await fetchApiFootballPage(year, page, from, to);
    all.push(...(body.response ?? []));
    const reportedTotal = Number(body.paging?.total ?? 1);
    if (!Number.isInteger(reportedTotal) || reportedTotal < 1) {
      throw new Error("API-Football devolvió un total de páginas inválido");
    }
    total = reportedTotal;
    if (total > MAX_API_FOOTBALL_PAGES) {
      throw new Error(`API-Football ${year}: ${total} páginas supera el límite seguro de ${MAX_API_FOOTBALL_PAGES}`);
    }
    page++;
  } while (page <= total);
  return [...new Map(all.map((fixture) => [fixture.fixture.id, fixture])).values()];
}

function conferenceHistoricalRecord(match: ApiFixture, year: number) {
  const date = match.fixture.date;
  const season = seasonLabel(year);
  return {
    id: conferenceHistoricalId(season, date.slice(0, 10), match.teams.home.name, match.teams.away.name),
    league_code: "UECL",
    league_name: "UEFA Conference League",
    season,
    match_date: date.slice(0, 10),
    kickoff_time: date.slice(11, 16) || null,
    home_team: match.teams.home.name,
    away_team: match.teams.away.name,
    home_goals: match.goals.home,
    away_goals: match.goals.away,
    home_shots: null,
    away_shots: null,
    home_shots_on_target: null,
    away_shots_on_target: null,
    home_corners: null,
    away_corners: null,
    home_yellow: null,
    away_yellow: null,
    home_red: null,
    away_red: null,
    source: "API-Football",
  };
}

async function saveConferenceFixture(db: Db, match: ApiFixture, year: number) {
  const competitionId = "848";
  const season = seasonLabel(year);
  const homeTeam: Team = { ...match.teams.home, id: stableHash("team|" + match.teams.home.name) };
  const awayTeam: Team = { ...match.teams.away, id: stableHash("team|" + match.teams.away.name) };
  const homeId = await upsertTeam(db, homeTeam, competitionId, season, CONFERENCE_TEAM_ID_OFFSET);
  const awayId = await upsertTeam(db, awayTeam, competitionId, season, CONFERENCE_TEAM_ID_OFFSET);
  const state = apiFixtureStatus(match.fixture.status.short);
  const stableMatchId = conferenceFixtureHash(season, match.fixture.date.slice(0, 10), match.teams.home.name, match.teams.away.name);
  const { error } = await db.from("partidos").upsert({
    id: conferenceNamespacedId(MATCH_ID_OFFSET, stableMatchId),
    competid_id: competitionId,
    temporada: season,
    jornada: 0,
    jornada_nombre: String(match.league.round ?? "Conference League").replaceAll("_", " "),
    fecha_utc: match.fixture.date,
    equipo_local_id: homeId,
    equipo_visitante_id: awayId,
    goles_local: match.goals.home,
    goles_visitante: match.goals.away,
    estado: state,
    fuente: "API-Football",
    sincronizado_at: new Date().toISOString(),
    raw_payload: match,
    estadisticas_estado: state === "FINISHED" ? "EMPTY_RESPONSE" : "PENDING",
  }, { onConflict: "id" });
  if (error) throw error;
  if (state === "FINISHED" && match.goals.home !== null && match.goals.away !== null) {
    const { error: historyError } = await db.from("historical_matches").upsert(
      [conferenceHistoricalRecord(match, year)],
      { onConflict: "league_code,season,match_date,home_team,away_team" },
    );
    if (historyError) throw historyError;
  }
}


async function fetchOpenMatchdayConferenceFixtures(year: number, from: string, to: string) {
  const seasonCode = String(year).slice(-2) + String(year + 1).slice(-2);
  const url = "https://raw.githubusercontent.com/oladeeayo/open-matchday/master/data/UEFA_1_conference-league/fixtures_" + seasonCode + ".csv";
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("open-matchday Conference HTTP " + response.status);
  const csv = (await response.text()).replace(/^\uFEFF/, "");
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const out: Array<{ round: number; date: string; time: string; home: string; away: string }> = [];
  for (const line of lines.slice(1)) {
    const [roundRaw, date, time, home, away] = line.split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !/^\d{2}:\d{2}$/.test(time ?? "") || !home || !away) continue;
    if (date < from || date > to) continue;
    out.push({ round: Number(roundRaw) || 0, date, time, home: home.trim(), away: away.trim() });
  }
  return out;
}

async function saveOpenMatchdayConferenceFixture(
  db: Db,
  match: { round: number; date: string; time: string; home: string; away: string },
  year: number,
) {
  const competitionId = "848";
  const season = seasonLabel(year);
  const homeTeam: Team = { id: stableHash("team|" + match.home), name: match.home };
  const awayTeam: Team = { id: stableHash("team|" + match.away), name: match.away };
  const homeId = await upsertTeam(db, homeTeam, competitionId, season, CONFERENCE_TEAM_ID_OFFSET);
  const awayId = await upsertTeam(db, awayTeam, competitionId, season, CONFERENCE_TEAM_ID_OFFSET);
  const kickoff = openMatchdayTimeToUtc(match.date, match.time);
  const id = conferenceNamespacedId(MATCH_ID_OFFSET, conferenceFixtureHash(season, match.date, match.home, match.away));
  const { error } = await db.from("partidos").upsert({
    id, competid_id: competitionId, temporada: season, jornada: match.round,
    jornada_nombre: "Jornada " + match.round, fecha_utc: kickoff,
    equipo_local_id: homeId, equipo_visitante_id: awayId,
    goles_local: null, goles_visitante: null, estado: "SCHEDULED",
    fuente: "open-matchday", sincronizado_at: new Date().toISOString(),
    raw_payload: match, estadisticas_estado: "PENDING",
  }, { onConflict: "id" });
  if (error) throw error;
}

async function syncConferenceLeague(db: Db, year: number, from: string, to: string) {
  const competitionId = "848";
  const season = seasonLabel(year);
  const { error: compError } = await db.from("competiciones").upsert({
    id: competitionId,
    nombre: "UEFA Conference League",
    pais: "Europa",
    temporada_actual: season,
    activo: true,
  }, { onConflict: "id" });
  if (compError) throw compError;

  // Primero guardar el calendario próximo: no debe depender de que el histórico esté completo.
  let current: ApiFixture[] = [];
  let saved = 0;
  let fixturesSeen = 0;
  let calendarSource = "API-Football";
  try {
    current = await fetchApiFootballSeason(year, from, to);
  } catch (error) {
    console.warn("conference_api_football_fallback", String(error).slice(0, 220));
  }
  if (current.length) {
    fixturesSeen = current.length;
    for (const match of current) {
      await saveConferenceFixture(db, match, year);
      saved++;
    }
  } else {
    const openFixtures = await fetchOpenMatchdayConferenceFixtures(year, from, to);
    for (const match of openFixtures) {
      await saveOpenMatchdayConferenceFixture(db, match, year);
      saved++;
    }
    fixturesSeen = openFixtures.length;
    calendarSource = "open-matchday";
  }

  // Importar como máximo una temporada histórica por ejecución (cron cada 6 h).
  // Así se reparte el consumo de API-Football y el calendario actual siempre se sincroniza.
  const historyOutcomes: Array<Record<string, unknown>> = [];
  let historyImported = 0;
  for (let startYear = 2021; startYear < year; startYear++) {
    const seasonCode = String(startYear % 100).padStart(2, "0") + String((startYear + 1) % 100).padStart(2, "0");
    const { data: log } = await db.from("historical_import_log")
      .select("last_run,status").eq("season_code", seasonCode).eq("league_code", "UECL").maybeSingle();
    if (log?.status === "ok" && Date.now() - new Date(log.last_run).getTime() < 24 * 3600 * 1000) {
      historyOutcomes.push({ temporada: seasonLabel(startYear), estado: "SKIPPED_RECENT" });
      continue;
    }
    try {
      const fixtures = await fetchApiFootballSeason(startYear);
      const records = fixtures
        .filter((m) => apiFixtureStatus(m.fixture.status.short) === "FINISHED" && m.goals.home !== null && m.goals.away !== null)
        .map((m) => conferenceHistoricalRecord(m, startYear));
      if (records.length === 0) {
        throw new Error(`API-Football ${seasonLabel(startYear)} no devolvió resultados históricos finalizados`);
      }
      for (let i = 0; i < records.length; i += 200) {
        const { error } = await db.from("historical_matches").upsert(records.slice(i, i + 200), {
          onConflict: "league_code,season,match_date,home_team,away_team",
        });
        if (error) throw error;
      }
      const { error: logError } = await db.from("historical_import_log").upsert({
        season_code: seasonCode, league_code: "UECL", last_run: new Date().toISOString(),
        rows_upserted: records.length, status: "ok",
      }, { onConflict: "season_code,league_code" });
      if (logError) throw logError;
      historyImported = records.length;
      historyOutcomes.push({ temporada: seasonLabel(startYear), estado: "SUCCESS", partidos_historicos: records.length });
    } catch (error) {
      const message = String(error).slice(0, 250);
      await db.from("historical_import_log").upsert({
        season_code: seasonCode, league_code: "UECL", last_run: new Date().toISOString(),
        rows_upserted: 0, status: "failed",
      }, { onConflict: "season_code,league_code" });
      historyOutcomes.push({ temporada: seasonLabel(startYear), estado: "FAILED", error: message });
    }
    break;
  }
  const { count: historyCount, error: countError } = await db.from("historical_matches")
    .select("id", { count: "exact", head: true }).eq("league_code", "UECL");
  if (countError) throw countError;
  return {
    competicion: "UEFA Conference League",
    estado: fixturesSeen === 0 ? "NO_FIXTURES" : historyOutcomes.some((item) => item.estado === "FAILED") ? "PARTIAL" : "SUCCESS",
    partidos_vistos: fixturesSeen,
    partidos_guardados: saved,
    fuente_calendario: calendarSource,
    aviso_calendario: fixturesSeen === 0 ? "Ninguna fuente devolvió partidos en la ventana consultada" : null,
    historico_importado: historyImported,
    temporadas_historicas: historyOutcomes,
    total_historico_disponible: historyCount ?? 0,
  };
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

    // Conference League: fuente alternativa API-Football (football-data.org Free no la cubre).
    try {
      const conferenceFrom = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const conferenceTo = new Date(now.getTime() + 45 * 86400000).toISOString().slice(0, 10);
      outcomes.push(await syncConferenceLeague(db, year, conferenceFrom, conferenceTo));
    } catch (error) {
      outcomes.push({ competicion: "UEFA Conference League", estado: "FAILED", error: String(error).slice(0, 350) });
    }

    // Europa League sigue desactivada: no se incorpora sin una fuente verificada.
    const { error: europaError } = await db.from("competiciones").upsert({
      id: "3", nombre: "UEFA Europa League", pais: "Europa", temporada_actual: season, activo: false,
    }, { onConflict: "id" });
    if (europaError) outcomes.push({ competicion: "3", estado: "FAILED", error: europaError.message });
    else outcomes.push({ competicion: "3", estado: "UNAVAILABLE_FREE_TIER" });

    const partial = outcomes.some((item) => item.estado === "FAILED" || item.estado === "PARTIAL" || item.estado === "NO_FIXTURES");
    const totals = outcomes.reduce<{ vistos: number; guardados: number }>((sum, item) => ({
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
