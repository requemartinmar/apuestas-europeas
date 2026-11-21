import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const API_BASE = "https://api.odds-api.io/v3";
const PROVIDER = "Odds-API.io";
const BOOKS = [
  { api: "Betfair Exchange", display: "Betfair Exchange" },
  { api: "Bet365", display: "Bet365" },
  { api: "DAZN Bet ES", display: "DAZN Bet" },
];
const CORS = {
  "Access-Control-Allow-Origin": "https://apuestas-europeas.vercel.app",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

type InputMatch = { id: number; home: string; away: string; kickoff: string };
type QuoteSide = number | null;
type NormalizedBook = {
  ml: { home: QuoteSide; draw: QuoteSide; away: QuoteSide };
  totals25: { over: QuoteSide; under: QuoteSide };
  btts: { yes: QuoteSide; no: QuoteSide };
  updatedAt: string | null;
  capturedAt: string;
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}
function asArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.events)) return value.events;
  if (Array.isArray(value?.results)) return value.results;
  return [];
}
function normalizeTeam(value: unknown): string {
  let name = String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  name = name.replace(/&/g, " and ").replace(/\b(fc|cf|afc|sc|s\.a\.d\.)\b/g, " ");
  name = name.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    "manchester city": "man city", "man city": "man city",
    "manchester united": "man united", "man utd": "man united",
    "athletic bilbao": "athletic club", "athletic club": "athletic club",
    "atletico": "atletico madrid", "atletico madrid": "atletico madrid",
    "paris saint germain": "psg", "paris sg": "psg", "psg": "psg",
    "inter milan": "inter", "internazionale": "inter", "inter": "inter",
    "bayern munich": "bayern", "bayern": "bayern",
    "borussia dortmund": "dortmund", "dortmund": "dortmund",
    "real betis": "betis", "betis": "betis",
    "celta vigo": "celta", "celta": "celta",
    "deportivo alaves": "alaves", "alaves": "alaves",
    "olympique marseille": "marseille", "olympique de marseille": "marseille",
    "olympique lyonnais": "lyon",
  };
  return aliases[name] ?? name;
}
function validPrice(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 1 ? n : null;
}
function getMarket(markets: any[], names: string[]): any | null {
  const wanted = new Set(names.map(x => x.toLowerCase()));
  return markets.find(m => wanted.has(String(m?.name ?? "").toLowerCase())) ?? null;
}
function marketRows(market: any): any[] {
  return Array.isArray(market?.odds) ? market.odds : [];
}
function normalizeBook(markets: any[], capturedAt: string): NormalizedBook {
  const ml = getMarket(markets, ["ML"]);
  const totals = getMarket(markets, ["Totals", "Goals Over/Under"]);
  const btts = getMarket(markets, ["Both Teams To Score", "BTTS"]);
  const mlRow = marketRows(ml)[0] ?? {};
  const totalsRow = marketRows(totals).find(row => {
    const line = Number(row?.max ?? row?.line ?? row?.hdp ?? row?.total);
    return Number.isFinite(line) && Math.abs(line - 2.5) < 0.0001;
  }) ?? {};
  const bttsRow = marketRows(btts)[0] ?? {};
  const stamps = [ml?.updatedAt, totals?.updatedAt, btts?.updatedAt]
    .filter((x): x is string => typeof x === "string" && Number.isFinite(Date.parse(x)));
  stamps.sort((a, b) => Date.parse(b) - Date.parse(a));
  return {
    ml: { home: validPrice(mlRow.home), draw: validPrice(mlRow.draw), away: validPrice(mlRow.away) },
    totals25: { over: validPrice(totalsRow.over), under: validPrice(totalsRow.under) },
    btts: { yes: validPrice(bttsRow.yes), no: validPrice(bttsRow.no) },
    updatedAt: stamps[0] ?? null,
    capturedAt,
  };
}
function quoteRows(matchId: number, books: Record<string, NormalizedBook>) {
  const rows: any[] = [];
  for (const book of BOOKS) {
    const data = books[book.api];
    if (!data) continue;
    const stamp = data.updatedAt ?? data.capturedAt;
    const groups: Array<[string, Record<string, QuoteSide>]> = [
      ["1X2", data.ml],
      ["Totales 2.5", data.totals25],
      ["Ambos marcan", data.btts],
    ];
    for (const [market, selections] of groups) {
      for (const [selection, price] of Object.entries(selections)) {
        if (price != null && Number.isFinite(price) && price > 1) {
          rows.push({
            partido_id: matchId,
            casa_apuestas: book.display,
            mercado: market,
            seleccion: selection,
            cuota: price,
            proveedor: PROVIDER,
            hora_captura: stamp,
          });
        }
      }
    }
  }
  return rows;
}
async function apiGet(path: string, params: Record<string, string>, apiKey: string) {
  const url = new URL(API_BASE + path);
  url.searchParams.set("apiKey", apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const result = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const raw = await result.text();
  let parsed: any = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!result.ok) {
    const message = String(parsed?.message ?? parsed?.error ?? "Respuesta no válida del proveedor").slice(0, 220);
    throw new Error("Proveedor HTTP " + result.status + ": " + message);
  }
  if (!parsed) throw new Error("El proveedor no devolvió JSON válido.");
  return parsed;
}
function matchEvent(match: InputMatch, events: any[]) {
  const home = normalizeTeam(match.home);
  const away = normalizeTeam(match.away);
  const kickoff = Date.parse(match.kickoff);
  if (!home || !away || !Number.isFinite(kickoff)) return null;
  const candidates = events.map(event => {
    const eventDate = Date.parse(event?.date ?? event?.startTime ?? event?.commenceTime ?? "");
    const sameTeams = normalizeTeam(event?.home) === home && normalizeTeam(event?.away) === away;
    const diff = Math.abs(eventDate - kickoff);
    return { event, eventDate, diff, sameTeams };
  }).filter(x => x.sameTeams && Number.isFinite(x.eventDate) && x.diff <= 4 * 60 * 60 * 1000)
    .sort((a, b) => a.diff - b.diff);
  return candidates[0]?.event ?? null;
}

const requestWindow = new Map<string, { start: number; count: number }>();
function isAllowedPublicKey(req: Request): boolean {
  const supplied = req.headers.get("apikey") ?? "";
  const legacy = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  let publishable: string[] = [];
  try {
    const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    if (raw) publishable = Object.values(JSON.parse(raw)).filter((x): x is string => typeof x === "string");
  } catch { /* Invalid platform key map: fall back to the legacy anon key. */ }
  return !!supplied && (supplied === legacy || publishable.includes(supplied));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return response({ status: "method_not_allowed" }, 405);
  if (!isAllowedPublicKey(req)) return response({ status: "unauthorized" }, 401);

  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  const window = requestWindow.get(ip);
  if (window && now - window.start < 60000 && window.count >= 20) {
    return response({ status: "rate_limited", message: "Límite temporal de consultas alcanzado." }, 429);
  }
  if (!window || now - window.start >= 60000) requestWindow.set(ip, { start: now, count: 1 });
  else requestWindow.set(ip, { start: window.start, count: window.count + 1 });

  const apiKey = Deno.env.get("ODDS_API_KEY");
  const capturedAt = new Date().toISOString();
  if (!apiKey) return response({
    status: "not_configured",
    source: PROVIDER,
    capturedAt,
    message: "Falta configurar ODDS_API_KEY en los secretos de Supabase.",
    matches: [],
  });

  let payload: any;
  try { payload = await req.json(); } catch { return response({ status: "invalid_json" }, 400); }
  const input: InputMatch[] = Array.isArray(payload?.matches) ? payload.matches.slice(0, 30) : [];
  const matches = input.filter(m =>
    Number.isSafeInteger(Number(m?.id)) &&
    typeof m?.home === "string" && m.home.trim() &&
    typeof m?.away === "string" && m.away.trim() &&
    typeof m?.kickoff === "string" && Number.isFinite(Date.parse(m.kickoff))
  ).map(m => ({ id: Number(m.id), home: m.home.trim(), away: m.away.trim(), kickoff: m.kickoff }));

  if (!matches.length) return response({ status: "ok", source: PROVIDER, capturedAt, matches: [] });

  try {
    const eventPayload = await apiGet("/events", { sport: "football" }, apiKey);
    const events = asArray(eventPayload);
    const matched = matches.map(match => {
      const event = matchEvent(match, events);
      return event ? { match, event } : { match, event: null };
    });
    const found = matched.filter(x => x.event && x.event.id != null);
    const oddsByEvent = new Map<string, any>();

    for (let i = 0; i < found.length; i += 10) {
      const batch = found.slice(i, i + 10);
      const ids = batch.map(x => String(x.event.id)).join(",");
      const oddsPayload = await apiGet("/odds/multi", {
        eventIds: ids,
        bookmakers: BOOKS.map(x => x.api).join(","),
      }, apiKey);
      for (const item of asArray(oddsPayload)) {
        const id = String(item?.id ?? item?.eventId ?? "");
        if (id) oddsByEvent.set(id, item);
      }
    }

    const resultMatches = matched.map(({ match, event }) => {
      if (!event) return {
        id: match.id, home: match.home, away: match.away, kickoff: match.kickoff,
        matched: false, bookmakers: {},
      };
      const odds = oddsByEvent.get(String(event.id));
      const rawBooks = odds?.bookmakers ?? {};
      const normalized: Record<string, NormalizedBook> = {};
      for (const book of BOOKS) {
        const markets = Array.isArray(rawBooks[book.api]) ? rawBooks[book.api] : [];
        normalized[book.api] = normalizeBook(markets, capturedAt);
      }
      return {
        id: match.id, home: match.home, away: match.away, kickoff: match.kickoff,
        matched: true, providerEventId: String(event.id), bookmakers: normalized,
      };
    });

    const savedRows = resultMatches.filter(x => x.matched)
      .flatMap(x => quoteRows(x.id, x.bookmakers as Record<string, NormalizedBook>));
    let stored = false;
    if (savedRows.length) {
      const projectUrl = Deno.env.get("SUPABASE_URL");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (projectUrl && serviceKey) {
        const save = await fetch(projectUrl.replace(/\/$/, "") + "/rest/v1/cuotas_mercado", {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: "Bearer " + serviceKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(savedRows),
        });
        if (save.ok) stored = true;
        else console.error("No se pudieron guardar las cuotas verificadas:", save.status, (await save.text()).slice(0, 300));
      }
    }

    return response({
      status: "ok",
      source: PROVIDER,
      capturedAt,
      stored,
      bookmakerNames: BOOKS.map(x => x.display),
      matches: resultMatches,
    });
  } catch (error) {
    console.error("sync-bookmaker-odds:", error);
    return response({
      status: "provider_error",
      source: PROVIDER,
      capturedAt,
      message: error instanceof Error ? error.message : "Error consultando la fuente de cuotas.",
      matches: [],
    });
  }
});
