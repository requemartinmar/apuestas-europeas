import { createClient } from "npm:@supabase/supabase-js@2";

const env = (name: string) => Deno.env.get(name)?.trim() ?? "";
const PROJECT_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const SYNC_SECRET = env("SYNC_FUNCTION_SECRET");
const AS_ROOT = "https://as.com";
const AS_LEAGUE = "primera";
const AS_SEASON = "2026_2027";
const MAX_MATCH_PAGES = 24;
const REQUEST_GAP_MS = 1100;

type MatchRow = {
  id: number;
  jornada: number | null;
  temporada: string;
  fecha_utc: string;
  estado: string;
  equipo_local_id: number;
  equipo_visitante_id: number;
  local: string;
  visitante: string;
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeTeam(value: unknown): string {
  const raw = String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/\b(fc|cf|afc|sc|ac|as|ssc|club|the|rc|ca|rdc)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  const aliases: Record<string, string> = {
    "athletic club": "athletic", "athletic bilbao": "athletic",
    "rcd espanyol de barcelona": "espanyol", "espanyol de barcelona": "espanyol", "espanyol barcelona": "espanyol",
    "real racing santander": "racing", "real racing de santander": "racing", "racing santander": "racing",
    "real sociedad de futbol": "real sociedad", "sociedad": "real sociedad",
    "rc celta de vigo": "celta", "celta vigo": "celta",
    "deportivo la coruna": "deportivo", "rc deportivo la coruna": "deportivo",
    "deportivo alaves": "alaves", "alaves": "alaves",
    "club atletico de madrid": "atletico madrid", "atletico": "atletico madrid",
    "real betis balompie": "betis", "real betis": "betis",
    "fc barcelona": "barcelona", "real madrid cf": "real madrid",
    "ca osasuna": "osasuna", "levante ud": "levante", "getafe cf": "getafe",
    "rayo vallecano de madrid": "rayo", "rayo vallecano": "rayo",
    "rcd mallorca": "mallorca", "villarreal cf": "villarreal",
  };
  return aliases[raw] ?? raw;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToLines(html: string): string[] {
  const visible = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|section|article|header|footer|h[1-6]|ul|ol|table|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(visible).split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function stablePlayerId(name: string): number {
  let hash = 2166136261;
  for (const char of normalizeTeam(name) + "|" + name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return -((hash >>> 0) % 2000000000 + 1);
}

function extractRoundLinks(html: string, round: number): string[] {
  const links = new Set<string>();
  const re = /href=["']([^"']*\/directo\/[^"'#?\s]+)["']/gi;
  for (const match of html.matchAll(re)) {
    try {
      const url = new URL(decodeEntities(match[1]), AS_ROOT);
      if (!url.hostname.endsWith("as.com")) continue;
      if (!url.pathname.includes("/directo/regular_a_" + round + "_")) continue;
      const base = url.pathname.split("/alineaciones/")[0].replace(/\/$/, "");
      links.add(AS_ROOT + base + "/alineaciones/amp/");
    } catch { /* ignore malformed links */ }
  }
  return [...links];
}

function parsePlayerLine(line: string): { number: number; name: string; minute: number | null } | null {
  const cleaned = line.replace(/[•·]/g, " ").trim();
  const match = cleaned.match(/^(\d{1,2})\s+(.+?)\s*(?:\((\d{1,3})\s*['’]?\)|(\d{1,3})['’])?$/);
  if (!match) return null;
  const number = Number(match[1]);
  let name = match[2].trim().replace(/\s+\d{1,3}['’]$/, "").replace(/\s+x\d+$/i, "").trim();
  if (!name || /^(ent|portero|defensa|centrocampista|delantero|banquillo)$/i.test(name)) return null;
  return { number, name, minute: match[3] ? Number(match[3]) : match[4] ? Number(match[4]) : null };
}

function parseTeamBlocks(lines: string[]): Array<{
  starters: Array<{ number: number; name: string; position: string; minute: number | null }>;
  substitutes: Array<{ number: number; name: string; minute: number | null }>;
  coach: string | null;
  formation: string | null;
}> {
  const starts = lines.map((line, index) => /^portero$/i.test(line) ? index : -1).filter((i) => i >= 0);
  const result = [];
  for (let n = 0; n < Math.min(starts.length, 2); n++) {
    const block = lines.slice(starts[n], starts[n + 1] ?? lines.length);
    const benchAt = block.findIndex((line) => /^banquillo$/i.test(line));
    if (benchAt < 0) continue;
    const starterLines = block.slice(1, benchAt);
    const benchLines = block.slice(benchAt + 1);
    let position = "Portero";
    const starters: Array<{ number: number; name: string; position: string; minute: number | null }> = [];
    for (const line of starterLines) {
      if (/^(portero|defensa|centrocampista|delantero)$/i.test(line)) {
        position = line;
        continue;
      }
      const player = parsePlayerLine(line);
      if (player) starters.push({ number: player.number, name: player.name, position, minute: player.minute });
    }
    const coachLine = benchLines.find((line) => /^ent\s+/i.test(line)) ?? "";
    const coachMatch = coachLine.match(/^ent\s+(.+?)\s+(\d-\d(?:-\d){1,2})$/i);
    const substitutes = benchLines
      .filter((line) => !/^ent\s+/i.test(line))
      .map(parsePlayerLine).filter((p): p is NonNullable<typeof p> => Boolean(p));
    if (starters.length >= 11) result.push({
      starters: starters.slice(0, 11),
      substitutes,
      coach: coachMatch?.[1]?.trim() ?? null,
      formation: coachMatch?.[2] ?? null,
    });
  }
  return result;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "CANCHA/1.0 (+https://apuestas-europeas.vercel.app; football match lineup importer)",
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "es-ES,es;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) throw new Error("AS HTTP " + response.status + " en " + url);
  return await response.text();
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (!SYNC_SECRET || request.headers.get("x-sync-secret") !== SYNC_SECRET) return reply({ error: "unauthorized" }, 401);
  if (!PROJECT_URL || !SERVICE_KEY) return reply({ error: "missing_supabase_secrets" }, 500);

  const body = await request.json().catch(() => ({}));
  const db = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const startedAt = new Date().toISOString();
  const { data: run, error: runError } = await db.from("press_match_sync_runs")
    .insert({ provider: "AS", status: "running" }).select("id").single();
  if (runError || !run) return reply({ error: "could_not_start_run", detail: runError?.message }, 500);

  let pagesFetched = 0;
  let matchesFound = 0;
  let lineupsSaved = 0;
  const outcomes: Record<string, unknown>[] = [];

  try {
    const now = new Date();
    const from = new Date(now.getTime() - 45 * 86400000).toISOString();
    const to = new Date(now.getTime() + 5 * 86400000).toISOString();
    const { data, error } = await db.from("partidos")
      .select("id,jornada,temporada,fecha_utc,estado,as_match_url,equipo_local_id,equipo_visitante_id,local:equipos!partidos_equipo_local_id_fkey(nombre),visitante:equipos!partidos_equipo_visitante_id_fkey(nombre)")
      .eq("competid_id", "140").eq("temporada", "2026/27")
      .gte("fecha_utc", from).lte("fecha_utc", to).order("fecha_utc", { ascending: true });
    if (error) throw new Error("No se pudieron leer partidos de LaLiga: " + error.message);

    const matches: MatchRow[] = (data ?? []).map((row: any) => ({
      ...row, local: row.local?.nombre ?? "", visitante: row.visitante?.nombre ?? "",
    }));
    if (!matches.length && !body?.as_url) {
      await db.from("press_match_sync_runs").update({
        finished_at: new Date().toISOString(), status: "success",
        details: { reason: "no_matches_in_window" },
      }).eq("id", run.id);
      return reply({ ok: true, pages_fetched: 0, matches_found: 0, lineups_saved: 0, reason: "no_matches_in_window" });
    }
    const { data: existing, error: existingError } = matches.length
      ? await db.from("partido_alineaciones").select("partido_id").in("partido_id", matches.map((m) => m.id).slice(0, 500))
      : { data: [], error: null };
    if (existingError) throw new Error("No se pudo comprobar alineaciones existentes: " + existingError.message);
    const hasAnyLineup = new Set((existing ?? []).map((row: any) => Number(row.partido_id)));
    const pending = matches.filter((m) => m.jornada && !hasAnyLineup.has(m.id));
    if (!pending.length && !body?.as_url) {
      await db.from("press_match_sync_runs").update({
        finished_at: new Date().toISOString(), status: "success",
        details: { reason: "no_pending_laliga_matches" },
      }).eq("id", run.id);
      return reply({ ok: true, pages_fetched: 0, matches_found: 0, lineups_saved: 0, reason: "no_pending_laliga_matches" });
    }

    const explicitUrl = typeof body?.as_url === "string" ? body.as_url : null;
    const explicitMatchId = Number(body?.match_id);
    let pages: Array<{ url: string; round: number | null; match_id?: number }> = [];
    let roundsChecked: number[] = [];

    if (explicitUrl) {
      const parsed = new URL(explicitUrl);
      if (parsed.hostname !== "as.com" || !parsed.pathname.includes("/directo/")) {
        throw new Error("as_url debe ser una URL pública de partido de as.com con ruta /directo/");
      }
      pages = [{ url: parsed.pathname.includes("/alineaciones/") ? explicitUrl : explicitUrl.replace(/\/$/, "") + "/alineaciones/amp/", round: null }];
    } else {
      const currentRound = pending
        .filter((m) => new Date(m.fecha_utc).getTime() >= now.getTime() - 14 * 86400000 &&
          new Date(m.fecha_utc).getTime() <= now.getTime() + 5 * 86400000)
        .reduce((max, m) => Math.max(max, Number(m.jornada)), 0);
      const availableRounds = [...new Set(pending.map((m) => Number(m.jornada)))].sort((a, b) => a - b);
      roundsChecked = currentRound
        ? [currentRound - 2, currentRound - 1, currentRound].filter((round) => availableRounds.includes(round))
        : availableRounds.slice(-3);
      for (const round of roundsChecked) {
        const roundUrl = AS_ROOT + "/resultados/futbol/" + AS_LEAGUE + "/" + AS_SEASON + "/jornada/regular_a_" + round + "/";
        try {
          const html = await fetchText(roundUrl);
          pagesFetched++;
          for (const url of extractRoundLinks(html, round)) pages.push({ url, round });
        } catch (error) {
          outcomes.push({ round, status: "round_page_error", error: String(error).slice(0, 200) });
        }
        await sleep(REQUEST_GAP_MS);
      }
    }

    const uniquePages = [...new Map(pages.map((p) => [p.url, p])).values()].slice(0, MAX_MATCH_PAGES);
    for (const page of uniquePages) {
      try {
        const html = await fetchText(page.url);
        pagesFetched++;
        const lines = htmlToLines(html);
        const flat = normalizeTeam(lines.join(" "));
        const match = pending.find((m) => {
          if (explicitMatchId && m.id !== explicitMatchId) return false;
          if (page.round !== null && Number(m.jornada) !== page.round) return false;
          const local = normalizeTeam(m.local);
          const away = normalizeTeam(m.visitante);
          return flat.includes(local) && flat.includes(away);
        });
        if (!match) {
          outcomes.push({ url: page.url, status: "no_matching_supabase_fixture" });
          await sleep(REQUEST_GAP_MS);
          continue;
        }
        matchesFound++;
        if (match.as_match_url !== page.url) {
          const { error: urlError } = await db.from("partidos").update({ as_match_url: page.url }).eq("id", match.id);
          if (urlError) throw new Error("No se pudo guardar URL de AS: " + urlError.message);
          match.as_match_url = page.url;
        }
        const teams = parseTeamBlocks(lines);
        if (teams.length !== 2 || teams.some((team) => team.starters.length !== 11)) {
          outcomes.push({ match_id: match.id, url: page.url, status: "lineups_not_published_or_markup_changed", parsed_teams: teams.length, starter_counts: teams.map((t) => t.starters.length) });
          await sleep(REQUEST_GAP_MS);
          continue;
        }

        const payloadRows: Record<string, unknown>[] = [];
        for (let side = 0; side < 2; side++) {
          const team = teams[side];
          const teamId = side === 0 ? match.equipo_local_id : match.equipo_visitante_id;
          const teamName = side === 0 ? match.local : match.visitante;
          const add = (player: { number: number; name: string; position?: string; minute?: number | null }, starter: boolean) => {
            payloadRows.push({
              partido_id: match.id, proveedor: "AS", fixture_id: -match.id,
              equipo_id: teamId, equipo: teamName, jugador_id: stablePlayerId(player.name),
              jugador: player.name, dorsal: player.number, posicion: player.position ?? "Sin posición",
              posicion_campo: null, titular: starter, formacion: team.formation,
              entrenador_id: null, entrenador: team.coach, minuto_entrada: starter ? null : player.minute, minuto_salida: starter ? player.minute : null,
              fuente_url: page.url, raw_payload: { provider: "AS", source_url: page.url, player_name_as_published: player.name, fixture_id_kind: "synthetic_supabase_match_id" },
              capturado_at: new Date().toISOString(),
            });
          };
          for (const player of team.starters) add(player, true);
          for (const player of team.substitutes) add(player, false);
        }

        const { error: saveError } = await db.from("partido_alineaciones").upsert(payloadRows, {
          onConflict: "partido_id,proveedor,jugador_id",
        });
        if (saveError) throw new Error("No se pudo guardar alineación AS: " + saveError.message);
        const { error: updateError } = await db.from("partidos").update({
          alineaciones_estado: "AVAILABLE",
          alineaciones_confirmadas_at: new Date().toISOString(),
        }).eq("id", match.id);
        if (updateError) throw new Error("No se pudo actualizar estado del partido: " + updateError.message);
        lineupsSaved += payloadRows.length;
        outcomes.push({
          match_id: match.id, home: match.local, away: match.visitante,
          url: page.url, starters: 22, substitutes: teams.reduce((sum, team) => sum + team.substitutes.length, 0),
          status: "saved",
        });
      } catch (error) {
        outcomes.push({ url: page.url, status: "error", error: String(error).slice(0, 300) });
      }
      await sleep(REQUEST_GAP_MS);
    }

    const status = outcomes.some((o) => o.status === "error" || o.status === "round_page_error") ? "partial" : "success";
    const { error: finishError } = await db.from("press_match_sync_runs").update({
      finished_at: new Date().toISOString(), status,
      pages_fetched: pagesFetched, matches_found: matchesFound, lineups_saved: lineupsSaved,
      details: { competition_id: 140, provider: "AS", rounds_checked: roundsChecked, outcomes },
    }).eq("id", run.id);
    if (finishError) throw new Error("No se pudo cerrar el registro: " + finishError.message);
    return reply({ ok: true, pages_fetched: pagesFetched, matches_found: matchesFound, lineups_saved: lineupsSaved, outcomes });
  } catch (error) {
    await db.from("press_match_sync_runs").update({
      finished_at: new Date().toISOString(), status: "failed",
      pages_fetched: pagesFetched, matches_found: matchesFound, lineups_saved: lineupsSaved,
      details: { error: String(error).slice(0, 500), outcomes },
    }).eq("id", run.id);
    return reply({ error: String(error).slice(0, 500), pages_fetched: pagesFetched, outcomes }, 500);
  }
});
