import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { MAX_API_FOOTBALL_PAGES, conferenceFixtureHash, conferenceHistoricalId, conferenceNamespacedId, openMatchdayTimeToUtc, stableHash } from "./conference-helpers.ts";

// El cliente usa el esquema público sin tipos generados; evita que ReturnType
// colapse las tablas a never al reutilizarlo en helpers.
type Db = SupabaseClient<any, any, any, any, any>;

/** Sincroniza ligas de football-data.org, Conference League y Nations League. */
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
const NATIONS_TEAM_ID_OFFSET = TEAM_ID_OFFSET + 2 * CONFERENCE_ID_GAP;
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
  const response = await fetch(url, { headers: { "X-Auth-Token": token }, signal: AbortSignal.timeout(15000) });
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

async function fetchApiFootballPage(year: number, page: number, from?: string, to?: string, leagueId = "848"): Promise<ApiFixtureEnvelope> {
  const key = env("API_FOOTBALL_KEY");
  if (!key) throw new Error("API_FOOTBALL_KEY no configurada");
  const url = new URL("https://v3.football.api-sports.io/fixtures");
  url.searchParams.set("league", leagueId);
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
    throw new Error("API-Football " + leagueId + " " + year + ": " + JSON.stringify(body.errors ?? body.message ?? response.status));
  }
  return body;
}

async function fetchApiFootballSeason(year: number, from?: string, to?: string, leagueId = "848"): Promise<ApiFixture[]> {
  const all: ApiFixture[] = [];
  let page = 1;
  let total = 1;
  do {
    const body = await fetchApiFootballPage(year, page, from, to, leagueId);
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


type ConferenceHistoricalRecord = ReturnType<typeof conferenceHistoricalRecord>;

function historicalMatchId(leagueCode: string, season: string, date: string, home: string, away: string): number {
  const value = ["historical", leagueCode, season, date, home, away].join("|").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9|]/g, "");
  let hash = 14695981039346656037n;
  for (let i = 0; i < value.length; i++) { hash ^= BigInt(value.charCodeAt(i)); hash = BigInt.asUintN(64, hash * 1099511628211n); }
  return 700_000_000_000_000 + Number(hash & ((1n << 48n) - 1n));
}
async function upsertHistoricalScoreRows(db: Db, records: Record<string, any>[]) {
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200); if (!chunk.length) continue;
    const leagueCode = String(chunk[0].league_code), season = String(chunk[0].season);
    const dates = [...new Set(chunk.map((row) => String(row.match_date)))];
    const { data: existingRows, error: readError } = await db.from("historical_matches").select("*").eq("league_code", leagueCode).eq("season", season).in("match_date", dates);
    if (readError) throw new Error("Lectura del histórico: " + readError.message);
    const byKey = new Map<string, any>();
    for (const row of existingRows ?? []) byKey.set(JSON.stringify([row.season,row.match_date,row.home_team,row.away_team]), row);
    const merged = chunk.map((record) => {
      const previous = byKey.get(JSON.stringify([record.season,record.match_date,record.home_team,record.away_team]));
      const stats = ["home_shots","away_shots","home_shots_on_target","away_shots_on_target","home_corners","away_corners","home_yellow","away_yellow","home_red","away_red"];
      const row: Record<string, any> = { ...record, id: previous?.id ?? record.id,
        home_goals: record.home_goals ?? previous?.home_goals ?? null, away_goals: record.away_goals ?? previous?.away_goals ?? null,
        kickoff_time: record.kickoff_time ?? previous?.kickoff_time ?? null, source: previous?.source ?? record.source, captured_at: new Date().toISOString() };
      for (const field of stats) row[field] = record[field] ?? previous?.[field] ?? null;
      return row;
    });
    const { error } = await db.from("historical_matches").upsert(merged,{onConflict:"league_code,season,match_date,home_team,away_team"});
    if (error) throw new Error("Guardado del histórico: " + error.message);
  }
}

async function upsertConferenceHistoricalRecords(
  db: Db,
  records: ConferenceHistoricalRecord[],
) {
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    if (chunk.length === 0) continue;

    const season = chunk[0].season;
    if (chunk.some((record) => record.season !== season)) {
      throw new Error("No se pueden mezclar temporadas en una importación Conference");
    }

    const dates = [...new Set(chunk.map((record) => record.match_date))];

    const { data: existingRows, error: readError } = await db
      .from("historical_matches")
      .select(
        "season,match_date,home_team,away_team,kickoff_time,home_shots,away_shots,home_shots_on_target,away_shots_on_target,home_corners,away_corners,home_yellow,away_yellow,home_red,away_red",
      )
      .eq("league_code", "UECL")
      .eq("season", season)
      .in("match_date", dates);

    if (readError) {
      throw new Error("No se pudieron leer las estadísticas Conference existentes: " + readError.message);
    }

    const existingByKey = new Map<string, any>();

    for (const row of existingRows ?? []) {
      const key = JSON.stringify([
        row.season,
        row.match_date,
        row.home_team,
        row.away_team,
      ]);
      existingByKey.set(key, row);
    }

    const merged = chunk.map((record) => {
      const key = JSON.stringify([
        record.season,
        record.match_date,
        record.home_team,
        record.away_team,
      ]);
      const previous = existingByKey.get(key);

      return {
        ...record,
        kickoff_time: record.kickoff_time ?? previous?.kickoff_time ?? null,
        home_shots: record.home_shots ?? previous?.home_shots ?? null,
        away_shots: record.away_shots ?? previous?.away_shots ?? null,
        home_shots_on_target: record.home_shots_on_target ?? previous?.home_shots_on_target ?? null,
        away_shots_on_target: record.away_shots_on_target ?? previous?.away_shots_on_target ?? null,
        home_corners: record.home_corners ?? previous?.home_corners ?? null,
        away_corners: record.away_corners ?? previous?.away_corners ?? null,
        home_yellow: record.home_yellow ?? previous?.home_yellow ?? null,
        away_yellow: record.away_yellow ?? previous?.away_yellow ?? null,
        home_red: record.home_red ?? previous?.home_red ?? null,
        away_red: record.away_red ?? previous?.away_red ?? null,
      };
    });

    const { error: upsertError } = await db
      .from("historical_matches")
      .upsert(merged, {
        onConflict: "league_code,season,match_date,home_team,away_team",
      });

    if (upsertError) throw upsertError;
  }
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
    await upsertConferenceHistoricalRecords(db, [
      conferenceHistoricalRecord(match, year),
    ]);
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

  // La Conference League usa OpenMatchday, que ya es la fuente gratuita
  // que estaba funcionando como fallback. Evitamos llamadas API-Football
  // que no aportaban calendario adicional ni histórico en el plan gratuito.
  const openFixtures = await fetchOpenMatchdayConferenceFixtures(year, from, to);
  let saved = 0;
  const fixturesSeen = openFixtures.length;
  const calendarSource = "open-matchday";
  for (const match of openFixtures) {
    await saveOpenMatchdayConferenceFixture(db, match, year);
    saved++;
  }

  // El proveedor gratuito no ofrece histórico de Conference League en este proyecto.
  // No repetimos consultas históricas que ya fallaron por restricciones del plan.
  const historyOutcomes: Array<Record<string, unknown>> = [{
    temporada: "Histórico",
    estado: "SKIPPED_FREE_TIER",
    nota: "Sin cobertura histórica gratuita confirmada; se conserva el calendario OpenMatchday.",
  }];
  const historyImported = 0;

  const { count: historyCount, error: countError } = await db.from("historical_matches")
    .select("id", { count: "exact", head: true }).eq("league_code", "UECL");
  if (countError) throw countError;
  return {
    competicion: "UEFA Conference League",
    estado: fixturesSeen === 0 ? "NO_FIXTURES" : historyOutcomes.some((item) => item.estado === "FAILED" || item.estado === "UNAVAILABLE" || item.estado === "SKIPPED_UNAVAILABLE") ? "PARTIAL" : "SUCCESS",
    partidos_vistos: fixturesSeen,
    partidos_guardados: saved,
    fuente_calendario: calendarSource,
    aviso_calendario: fixturesSeen === 0 ? "Ninguna fuente devolvió partidos en la ventana consultada" : null,
    historico_importado: historyImported,
    temporadas_historicas: historyOutcomes,
    total_historico_disponible: historyCount ?? 0,
  };
}

type FixtureDownloadMatch = {
  MatchNumber: number;
  RoundNumber: number;
  DateUtc: string;
  Location?: string | null;
  HomeTeam: string;
  AwayTeam: string;
  Group?: string | null;
  HomeTeamScore: number | null;
  AwayTeamScore: number | null;
  Winner?: string | null;
};

async function fetchFixtureDownloadNations(year: number, from: string, to: string): Promise<FixtureDownloadMatch[]> {
  const url = `https://fixturedownload.com/feed/json/nations-league-${year}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`FixtureDownload Nations League HTTP ${response.status}`);
  const body = await response.json() as unknown;
  if (!Array.isArray(body)) throw new Error("FixtureDownload devolvió un JSON que no es una lista");
  const valid = body.filter((item): item is FixtureDownloadMatch => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return typeof row.DateUtc === "string" &&
      typeof row.HomeTeam === "string" && row.HomeTeam.trim().length > 0 &&
      typeof row.AwayTeam === "string" && row.AwayTeam.trim().length > 0 &&
      Number.isFinite(Date.parse(row.DateUtc));
  });
  if (valid.length === 0) throw new Error("FixtureDownload no devolvió partidos válidos para Nations League");
  const filtered = valid.filter((match) => {
    const date = new Date(match.DateUtc).toISOString().slice(0, 10);
    return date >= from && date <= to;
  });
  return [...new Map(filtered.map((match) => [
    `${new Date(match.DateUtc).toISOString()}|${match.HomeTeam}|${match.AwayTeam}`,
    match,
  ])).values()];
}

async function syncNationsLeague(db: Db, year: number, from: string, to: string) {
  const competitionId = "5";
  const season = seasonLabel(year);
  const { error: compError } = await db.from("competiciones").upsert({
    id: competitionId, nombre: "UEFA Nations League", pais: "Europa", temporada_actual: season, activo: true,
  }, { onConflict: "id" });
  if (compError) throw compError;

  console.info("nations_fixture_fetch_start", { year, from, to });
  const fixtures = await fetchFixtureDownloadNations(year, from, to);
  if (fixtures.length === 0) {
    return { competicion: "UEFA Nations League", estado: "NO_FIXTURES", partidos_vistos: 0, partidos_guardados: 0, fuente_calendario: "FixtureDownload" };
  }

  // Upserts por lotes: 3 operaciones de base de datos, no 3 por cada partido.
  const teams = new Map<string, { id: number; nombre: string; nombre_corto: string | null; escudo_url: string | null }>();
  for (const match of fixtures) {
    for (const name of [match.HomeTeam, match.AwayTeam]) {
      const key = name.trim();
      if (!teams.has(key)) {
        teams.set(key, {
          id: internalId(NATIONS_TEAM_ID_OFFSET, stableHash("nations-team|" + key)),
          nombre: key, nombre_corto: null, escudo_url: null,
        });
      }
    }
  }
  const teamRows = [...teams.values()];
  const linkRows = teamRows.map(team => ({ equipo_id: team.id, competicion_id: competitionId, temporada: season }));
  for (let i = 0; i < teamRows.length; i += 500) {
    const { error } = await db.from("equipos").upsert(teamRows.slice(i, i + 500), { onConflict: "id" });
    if (error) throw error;
  }
  for (let i = 0; i < linkRows.length; i += 500) {
    const { error } = await db.from("equipo_competiciones").upsert(linkRows.slice(i, i + 500), { onConflict: "equipo_id,competicion_id,temporada" });
    if (error) throw error;
  }

  const matchRows = fixtures.map(match => {
    const kickoff = new Date(match.DateUtc).toISOString();
    const matchHash = stableHash("nations-match|" + season + "|" + kickoff.slice(0, 10) + "|" + match.HomeTeam + "|" + match.AwayTeam);
    const hasScore = typeof match.HomeTeamScore === "number" && Number.isFinite(match.HomeTeamScore) &&
      typeof match.AwayTeamScore === "number" && Number.isFinite(match.AwayTeamScore);
    return {
      id: conferenceNamespacedId(MATCH_ID_OFFSET + 2 * CONFERENCE_ID_GAP, matchHash),
      competid_id: competitionId, temporada: season,
      jornada: Number(match.RoundNumber) || 0,
      jornada_nombre: String(match.Group || (match.RoundNumber ? `Jornada ${match.RoundNumber}` : "UEFA Nations League")),
      fecha_utc: kickoff,
      equipo_local_id: teams.get(match.HomeTeam.trim())!.id,
      equipo_visitante_id: teams.get(match.AwayTeam.trim())!.id,
      goles_local: hasScore ? match.HomeTeamScore : null,
      goles_visitante: hasScore ? match.AwayTeamScore : null,
      estado: hasScore ? "FINISHED" : "SCHEDULED",
      fuente: "FixtureDownload", sincronizado_at: new Date().toISOString(),
      raw_payload: match, estadisticas_estado: hasScore ? "EMPTY_RESPONSE" : "PENDING",
    };
  });
  let saved = 0;
  for (let i = 0; i < matchRows.length; i += 500) {
    const chunk = matchRows.slice(i, i + 500);
    const { error } = await db.from("partidos").upsert(chunk, { onConflict: "id" });
    if (error) throw error;
    saved += chunk.length;
  }
  console.info("nations_fixture_sync_complete", { fixtures: fixtures.length, teams: teamRows.length, saved });
  return { competicion: "UEFA Nations League", estado: "SUCCESS", partidos_vistos: fixtures.length, partidos_guardados: saved, equipos: teamRows.length, fuente_calendario: "FixtureDownload" };
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
    // Nations League primero: se guarda antes de la sincronización secundaria más lenta.
    try {
      const nationsFrom = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const nationsTo = new Date(now.getTime() + 45 * 86400000).toISOString().slice(0, 10);
      outcomes.push(await syncNationsLeague(db, year, nationsFrom, nationsTo));
    } catch (error) {
      console.error("nations_league_sync_failed", String(error).slice(0, 350));
      outcomes.push({ competicion: "UEFA Nations League", estado: "FAILED", error: String(error).slice(0, 350) });
    }


    for (const competition of COMPETITIONS) {
      let matchesSeen = 0;
      let matchesSaved = 0;
      const historicalRows: Record<string, any>[] = [];
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
          const homeGoals = match.score?.fullTime?.home ?? null;
          const awayGoals = match.score?.fullTime?.away ?? null;
          if (normalizedStatus(match.status) === "FINISHED" && Number.isInteger(homeGoals) && Number.isInteger(awayGoals) && Number(homeGoals) >= 0 && Number(awayGoals) >= 0) {
            const matchDate = match.utcDate.slice(0, 10);
            historicalRows.push({
              id: historicalMatchId(competition.code, season, matchDate, match.homeTeam.name, match.awayTeam.name),
              league_code: competition.code, league_name: competition.name, season, match_date: matchDate,
              kickoff_time: match.utcDate.slice(11, 16) || null, home_team: match.homeTeam.name, away_team: match.awayTeam.name,
              home_goals: Number(homeGoals), away_goals: Number(awayGoals),
              home_shots: null, away_shots: null, home_shots_on_target: null, away_shots_on_target: null,
              home_corners: null, away_corners: null, home_yellow: null, away_yellow: null, home_red: null, away_red: null, source: PROVIDER,
            });
          }
        }
        if (historicalRows.length) await upsertHistoricalScoreRows(db, historicalRows);
        outcomes.push({ competicion: competition.code, estado: "SUCCESS", partidos_vistos: matchesSeen, partidos_guardados: matchesSaved, resultados_historicos: historicalRows.length });
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


