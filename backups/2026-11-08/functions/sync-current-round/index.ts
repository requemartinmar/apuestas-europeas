import { createClient } from "npm:@supabase/supabase-js@2";
const PROVIDER = "football-data.org";
const API = "https://api.football-data.org/v4";
const COMPS = [
  { id: "140", code: "PD", name: "LaLiga", country: "España" },
  { id: "39", code: "PL", name: "Premier League", country: "Inglaterra" },
  { id: "78", code: "BL1", name: "Bundesliga", country: "Alemania" },
  { id: "135", code: "SA", name: "Serie A", country: "Italia" },
  { id: "2", code: "CL", name: "UEFA Champions League", country: "Europa" },
];
const MATCH_OFFSET = 8000000000000000;
const TEAM_OFFSET = 7000000000000000;
type Team = { id: number; name: string; shortName?: string | null; tla?: string | null; crest?: string | null };
type Match = { id: number; utcDate: string; status: string; matchday?: number | null; stage?: string | null; homeTeam: Team; awayTeam: Team; score?: { fullTime?: { home: number | null; away: number | null } } };
type Envelope = { matches?: Match[]; message?: string };
const env = (key: string) => Deno.env.get(key)?.trim() ?? "";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const yearNow = () => { const d = new Date(); return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
const seasonName = (y: number) => y + "/" + String(y + 1).slice(-2);
const statusName = (s: string) => s === "FINISHED" ? "FINISHED" : ["IN_PLAY", "PAUSED", "LIVE", "SUSPENDED"].includes(s) ? "LIVE" : s === "POSTPONED" ? "POSTPONED" : ["CANCELLED", "AWARDED"].includes(s) ? "NOT_PLAYED" : "SCHEDULED";
async function getMatches(code: string, year: number, token: string, from: string, to: string) {
  const url = new URL(API + "/competitions/" + code + "/matches");
  url.searchParams.set("season", String(year)); url.searchParams.set("dateFrom", from); url.searchParams.set("dateTo", to);
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  const data = await res.json() as Envelope;
  if (!res.ok) throw new Error(data.message ?? ("HTTP " + res.status));
  return data.matches ?? [];
}
async function saveTeam(db: ReturnType<typeof createClient>, team: Team, comp: string, season: string) {
  const id = TEAM_OFFSET + team.id;
  const { error } = await db.from("equipos").upsert({ id, nombre: team.name, nombre_corto: team.tla ?? team.shortName ?? null, escudo_url: team.crest ?? null }, { onConflict: "id" });
  if (error) throw error;
  const { error: linkError } = await db.from("equipo_competiciones").upsert({ equipo_id: id, competicion_id: comp, temporada: season }, { onConflict: "equipo_id,competicion_id,temporada" });
  if (linkError) throw linkError;
  return id;
}
Deno.serve(async (request) => {
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const syncSecret = env("SYNC_FUNCTION_SECRET");
  if (!syncSecret || request.headers.get("x-sync-secret") !== syncSecret) return reply({ error: "unauthorized" }, 401);
  const token = env("FOOTBALL_DATA_API_TOKEN");
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  if (!token || !env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) return reply({ error: "missing_function_secrets" }, 500);
  const year = Number(env("FOOTBALL_SEASON") || yearNow());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return reply({ error: "invalid_season" }, 500);
  const season = seasonName(year);
  const { data: run, error: logError } = await db.from("sincronizaciones").insert({ proveedor: PROVIDER, temporada: season, tipo: "JORNADA_ACTUAL", estado: "RUNNING" }).select("id").single();
  if (logError) return reply({ error: logError.message }, 500);
  const now = Date.now();
  const from = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const to = new Date(now + 15 * 86400000).toISOString().slice(0, 10);
  const outcomes: Array<Record<string, unknown>> = [];
  for (const comp of COMPS) {
    try {
      const matches = await getMatches(comp.code, year, token, from, to);
      const { error: compError } = await db.from("competiciones").upsert({ id: comp.id, nombre: comp.name, pais: comp.country, temporada_actual: season, activo: true }, { onConflict: "id" });
      if (compError) throw compError;
      for (const m of matches) {
        const home = await saveTeam(db, m.homeTeam, comp.id, season);
        const away = await saveTeam(db, m.awayTeam, comp.id, season);
        const label = m.matchday ? "Jornada " + m.matchday : String(m.stage ?? "Ronda sin etiqueta").replaceAll("_", " ");
        const state = statusName(m.status);
        const { error } = await db.from("partidos").upsert({
          id: MATCH_OFFSET + m.id, competid_id: comp.id, temporada: season, jornada: m.matchday ?? 0,
          jornada_nombre: label, fecha_utc: m.utcDate, equipo_local_id: home, equipo_visitante_id: away,
          goles_local: m.score?.fullTime?.home ?? null, goles_visitante: m.score?.fullTime?.away ?? null,
          estado: state, fuente: PROVIDER, sincronizado_at: new Date().toISOString(), raw_payload: m,
          estadisticas_estado: state === "FINISHED" ? "EMPTY_RESPONSE" : "PENDING",
        }, { onConflict: "id" });
        if (error) throw error;
      }
      outcomes.push({ competicion: comp.code, estado: "SUCCESS", partidos_guardados: matches.length });
    } catch (error) {
      outcomes.push({ competicion: comp.code, estado: "FAILED", error: String(error).slice(0, 350) });
    }
  }
  for (const [id, name] of [["3", "UEFA Europa League"], ["848", "UEFA Conference League"]]) {
    const { error } = await db.from("competiciones").upsert({ id, nombre: name, pais: "Europa", temporada_actual: season, activo: false }, { onConflict: "id" });
    if (error) outcomes.push({ competicion: id, estado: "FAILED", error: error.message });
    else outcomes.push({ competicion: id, estado: "UNAVAILABLE_FREE_TIER" });
  }
  const failed = outcomes.some((x) => x.estado === "FAILED");
  const saved = outcomes.reduce((n, x) => n + Number(x.partidos_guardados ?? 0), 0);
  const { error: endError } = await db.from("sincronizaciones").update({ estado: failed ? "PARTIAL" : "SUCCESS", terminada_at: new Date().toISOString(), partidos_vistos: saved, partidos_guardados: saved, estadisticas_guardadas: 0, detalle: { outcomes, desde: from, hasta_exclusiva: to, nota: "El plan gratuito no incluye estadísticas detalladas." } }).eq("id", run.id);
  if (endError) return reply({ error: endError.message, outcomes }, 500);
  return reply({ temporada: season, fuente: PROVIDER, outcomes });
});