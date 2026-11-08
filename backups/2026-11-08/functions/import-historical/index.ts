import { createClient } from "npm:@supabase/supabase-js@2";

// Importa resultados + estadisticas de football-data.co.uk a public.historical_matches.
// Body opcional (JSON): { "seasons": ["2627","2526"], "leagues": ["SP1","E0"] }
// Sin body: temporada actual y las 4 ligas.

const LEAGUES: Record<string, string> = {
  E0: "Premier League",
  SP1: "LaLiga",
  D1: "Bundesliga",
  I1: "Serie A",
};
const BASE = "https://www.football-data.co.uk/mmz4281";
const THROTTLE_HOURS = 6; // no volver a descargar el mismo archivo antes de 6 h
const DELAY_MS = 1000; // pausa entre descargas, por cortesia con su servidor

function currentSeasonCode(d = new Date()): string {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1; // desde julio: temporada nueva
  const a = String(start % 100).padStart(2, "0");
  const b = String((start + 1) % 100).padStart(2, "0");
  return a + b;
}

function seasonLabel(code: string): string {
  const a = 2000 + parseInt(code.slice(0, 2), 10);
  return `${a}/${code.slice(2)}`;
}

function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((x) => x !== "")) rows.push(row);
  }
  return rows;
}

function toInt(v?: string): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toDate(v?: string): string | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = parseInt(m[3], 10);
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function toTime(v?: string): string | null {
  if (!v) return null;
  const t = v.trim();
  return /^\d{1,2}:\d{2}$/.test(t) ? t : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch { /* sin body */ }

  const seasons: string[] =
    Array.isArray(body.seasons) && body.seasons.length
      ? body.seasons.filter((s: unknown) => typeof s === "string" && /^\d{4}$/.test(s)).slice(0, 6)
      : [currentSeasonCode()];
  const leagues: string[] = (
    Array.isArray(body.leagues) && body.leagues.length ? body.leagues : Object.keys(LEAGUES)
  ).filter((l: string) => l in LEAGUES);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const results: Record<string, unknown>[] = [];
  let first = true;

  for (const season of seasons) {
    for (const league of leagues) {
      const tag = { season, league };

      const { data: log } = await supabase
        .from("historical_import_log")
        .select("last_run")
        .eq("season_code", season)
        .eq("league_code", league)
        .maybeSingle();
      if (log && Date.now() - new Date(log.last_run).getTime() < THROTTLE_HOURS * 3600e3) {
        results.push({ ...tag, status: `omitido: ya descargado hace menos de ${THROTTLE_HOURS} h` });
        continue;
      }

      if (!first) await sleep(DELAY_MS);
      first = false;

      let text: string;
      try {
        const res = await fetch(`${BASE}/${season}/${league}.csv`, {
          headers: { "User-Agent": "cancha-historical-import/1.0 (uso personal)" },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
          results.push({ ...tag, status: `error HTTP ${res.status}` });
          continue;
        }
        text = await res.text();
      } catch (e) {
        results.push({ ...tag, status: `error de descarga: ${(e as Error).message}` });
        continue;
      }

      const table = parseCsv(text);
      if (table.length < 2) {
        results.push({ ...tag, status: "archivo vacio" });
        continue;
      }
      const header = table[0].map((h) => h.trim());
      const idx = (name: string) => header.indexOf(name);
      const required = ["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"];
      if (required.some((c) => idx(c) < 0)) {
        results.push({ ...tag, status: "formato inesperado (faltan columnas)" });
        continue;
      }
      const get = (r: string[], name: string) => (idx(name) >= 0 ? r[idx(name)] : undefined);

      const unique = new Map<string, Record<string, unknown>>();
      for (const r of table.slice(1)) {
        const date = toDate(get(r, "Date"));
        const home = (get(r, "HomeTeam") ?? "").trim();
        const away = (get(r, "AwayTeam") ?? "").trim();
        const hg = toInt(get(r, "FTHG"));
        const ag = toInt(get(r, "FTAG"));
        if (!date || !home || !away || hg === null || ag === null) continue; // partido no jugado o fila rota
        const rec = {
          league_code: league,
          league_name: LEAGUES[league],
          season: seasonLabel(season),
          match_date: date,
          kickoff_time: toTime(get(r, "Time")),
          home_team: home,
          away_team: away,
          home_goals: hg,
          away_goals: ag,
          home_shots: toInt(get(r, "HS")),
          away_shots: toInt(get(r, "AS")),
          home_shots_on_target: toInt(get(r, "HST")),
          away_shots_on_target: toInt(get(r, "AST")),
          home_corners: toInt(get(r, "HC")),
          away_corners: toInt(get(r, "AC")),
          home_yellow: toInt(get(r, "HY")),
          away_yellow: toInt(get(r, "AY")),
          home_red: toInt(get(r, "HR")),
          away_red: toInt(get(r, "AR")),
        };
        unique.set(`${league}|${rec.season}|${date}|${home}|${away}`, rec);
      }
      const records = [...unique.values()];

      let failed: string | null = null;
      for (let i = 0; i < records.length; i += 200) {
        const { error } = await supabase
          .from("historical_matches")
          .upsert(records.slice(i, i + 200), {
            onConflict: "league_code,season,match_date,home_team,away_team",
          });
        if (error) { failed = error.message; break; }
      }
      if (failed) {
        results.push({ ...tag, status: `error al guardar: ${failed}` });
        continue;
      }

      await supabase.from("historical_import_log").upsert({
        season_code: season,
        league_code: league,
        last_run: new Date().toISOString(),
        rows_upserted: records.length,
        status: "ok",
      });
      results.push({ ...tag, status: "ok", partidos: records.length });
    }
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
