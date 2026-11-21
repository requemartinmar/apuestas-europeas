import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const API_BASE = "https://api.oddspapi.io/v4";
const PROVIDER = "OddsPapi";
const BOOKS = [
  { api: "betfair-ex", key: "Betfair Exchange", display: "Betfair Exchange" },
  { api: "bet365", key: "Bet365", display: "Bet365" },
];
const DAZN_LABEL = "DAZN Bet";
const TARGET_TOURNAMENTS = new Set([
  "laliga", "premier-league", "bundesliga", "serie-a", "ligue-1",
  "uefa-champions-league", "uefa-europa-league",
]);
const CACHE_TTL = 24 * 60 * 60 * 1000;
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
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.fixtures)) return value.fixtures;
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
function priceAt(outcome: any): { price: number | null; changedAt: string | null } {
  const players = outcome?.players ?? {};
  const player = players["0"] ?? Object.values(players)[0] ?? null;
  if (!player || player.active === false) return { price: null, changedAt: null };
  const changedAt = typeof player.changedAt === "string" && Number.isFinite(Date.parse(player.changedAt))
    ? player.changedAt : null;
  return { price: validPrice(player.price), changedAt };
}
function outcomesFor(book: any, marketId: string): Record<string, any> {
  const market = book?.markets?.[marketId];
  if (!market || market.marketActive === false) return {};
  return market.outcomes ?? {};
}
function latestStamp(values: Array<string | null>): string | null {
  return values.filter((x): x is string => !!x && Number.isFinite(Date.parse(x)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
function normalizeBook(book: any, capturedAt: string): NormalizedBook {
  const oneXtwo = outcomesFor(book, "101");
  const btts = outcomesFor(book, "104");
  const h = priceAt(oneXtwo["101"]);
  const d = priceAt(oneXtwo["102"]);
  const a = priceAt(oneXtwo["103"]);
  const yes = priceAt(btts["104"]);
  const no = priceAt(btts["105"]);
  let over: QuoteSide = null, under: QuoteSide = null;
  const stamps: Array<string | null> = [h.changedAt, d.changedAt, a.changedAt, yes.changedAt, no.changedAt];
  for (const market of Object.values(book?.markets ?? {}) as any[]) {
    if (!market || market.marketActive === false) continue;
    for (const outcome of Object.values(market.outcomes ?? {}) as any[]) {
      const quote = priceAt(outcome);
      const label = String(outcome?.players?.["0"]?.bookmakerOutcomeId ?? Object.values(outcome?.players ?? {})[0]?.bookmakerOutcomeId ?? "").toLowerCase();
      if (/2[.,]5\s*\/\s*over|over\s*2[.,]5|over.*2[.,]5/.test(label)) over = quote.price;
      if (/2[.,]5\s*\/\s*under|under\s*2[.,]5|under.*2[.,]5/.test(label)) under = quote.price;
      stamps.push(quote.changedAt);
    }
  }
  return {
    ml: { home: h.price, draw: d.price, away: a.price },
    totals25: { over, under },
    btts: { yes: yes.price, no: no.price },
    updatedAt: latestStamp(stamps),
    capturedAt,
  };
}
function quoteRows(matchId: number, books: Record<string, NormalizedBook>) {
  const rows: any[] = [];
  for (const book of BOOKS) {
    const data = books[book.key];
    if (!data) continue;
    const stamp = data.updatedAt ?? data.capturedAt;
    const groups: Array<[string, Record<string, QuoteSide>]> = [
      ["1X2", data.ml], ["Totales 2.5", data.totals25], ["Ambos marcan", data.btts],
    ];
    for (const [market, selections] of groups) {
      for (const [selection, price] of Object.entries(selections)) {
        if (price != null && Number.isFinite(price) && price > 1) {
          rows.push({
            partido_id: matchId, casa_apuestas: book.display, mercado: market,
            seleccion: selection, cuota: price, proveedor: PROVIDER, hora_captura: stamp,
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
  const result = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const raw = await result.text();
  let parsed: any = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!result.ok) {
    const code = parsed?.error?.code ?? parsed?.code ?? "";
    const message = String(parsed?.error?.message ?? parsed?.message ?? parsed?.details ?? "Respuesta no válida del proveedor").slice(0, 220);
    throw new Error("OddsPapi HTTP " + result.status + (code ? " [" + code + "]" : "") + ": " + message);
  }
  if (!parsed) throw new Error("OddsPapi no devolvió JSON válido.");
  return parsed;
}
function matchFixture(match: InputMatch, fixtures: any[]) {
  const home = normalizeTeam(match.home), away = normalizeTeam(match.away);
  const kickoff = Date.parse(match.kickoff);
  if (!home || !away || !Number.isFinite(kickoff)) return null;
  const candidates = fixtures.map(fixture => {
    const fixtureHome = normalizeTeam(fixture?.participant1Name ?? fixture?.participants?.home?.name ?? fixture?.home);
    const fixtureAway = normalizeTeam(fixture?.participant2Name ?? fixture?.participants?.away?.name ?? fixture?.away);
    const start = Date.parse(fixture?.startTime ?? fixture?.date ?? "");
    const sameTeams = fixtureHome === home && fixtureAway === away;
    return { fixture, start, diff: Math.abs(start - kickoff), sameTeams };
  }).filter(x => x.sameTeams && Number.isFinite(x.start) && x.diff <= 4 * 60 * 60 * 1000)
    .sort((a, b) => a.diff - b.diff);
  return candidates[0]?.fixture ?? null;
}

const requestWindow = new Map<string, { start: number; count: number }>();
let cachedProviderData: { at: number; fixtures: any[] } | null = null;
let cachedTournaments: { at: number; ids: number[] } | null = null;

function isAllowedPublicKey(req: Request): boolean {
  const supplied = req.headers.get("apikey") ?? "";
  const legacy = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  let publishable: string[] = [];
  try {
    const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    if (raw) publishable = Object.values(JSON.parse(raw)).filter((x): x is string => typeof x === "string");
  } catch { /* Ignore invalid optional key map. */ }
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

  const apiKey = Deno.env.get("ODDSPAPI_API_KEY");
  const capturedAt = new Date().toISOString();
  if (!apiKey) return response({
    status: "not_configured", source: PROVIDER, capturedAt,
    message: "Falta configurar ODDSPAPI_API_KEY en los secretos de Supabase.", matches: [],
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
    if (!cachedTournaments || now - cachedTournaments.at >= CACHE_TTL) {
      const tournamentPayload = await apiGet("/tournaments", { sportId: "10", language: "en" }, apiKey);
      const tournaments = asArray(tournamentPayload);
      const ids = tournaments.filter(t => TARGET_TOURNAMENTS.has(String(t?.tournamentSlug ?? "")))
        .map(t => Number(t.tournamentId)).filter(id => Number.isSafeInteger(id) && id > 0);
      if (!ids.length) throw new Error("OddsPapi no devolvió IDs para las competiciones configuradas.");
      cachedTournaments = { at: now, ids };
    }

    if (!cachedProviderData || now - cachedProviderData.at >= CACHE_TTL) {
      const allFixtures: any[] = [];
      const ids = cachedTournaments.ids;
      for (let i = 0; i < ids.length; i += 3) {
        const tournamentIds = ids.slice(i, i + 3).join(",");
        for (const book of BOOKS) {
          const oddsPayload = await apiGet("/odds-by-tournaments", {
            tournamentIds, bookmaker: book.api, language: "en", verbosity: "3",
          }, apiKey);
          for (const fixture of asArray(oddsPayload)) {
            const existing = allFixtures.find(x => String(x.fixtureId) === String(fixture.fixtureId));
            if (!existing) allFixtures.push(fixture);
            else existing.bookmakerOdds = { ...(existing.bookmakerOdds ?? {}), ...(fixture.bookmakerOdds ?? {}) };
          }
        }
      }
      cachedProviderData = { at: now, fixtures: allFixtures };
    }

    const resultMatches = matches.map(match => {
      const fixture = matchFixture(match, cachedProviderData!.fixtures);
      if (!fixture) return {
        id: match.id, home: match.home, away: match.away, kickoff: match.kickoff,
        matched: false, bookmakers: {},
      };
      const rawBooks = fixture.bookmakerOdds ?? {};
      const normalized: Record<string, NormalizedBook> = {};
      for (const book of BOOKS) {
        const raw = rawBooks[book.api];
        if (raw) normalized[book.key] = normalizeBook(raw, capturedAt);
      }
      return {
        id: match.id, home: match.home, away: match.away, kickoff: match.kickoff,
        matched: true, providerEventId: String(fixture.fixtureId),
        bookmakers: normalized,
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
            apikey: serviceKey, Authorization: "Bearer " + serviceKey,
            "Content-Type": "application/json", Prefer: "return=minimal",
          },
          body: JSON.stringify(savedRows),
        });
        if (save.ok) stored = true;
        else console.error("No se pudieron guardar las cuotas verificadas:", save.status, (await save.text()).slice(0, 300));
      }
    }

    return response({
      status: "ok", source: PROVIDER, capturedAt, stored,
      bookmakerNames: [...BOOKS.map(x => x.display), DAZN_LABEL],
      daznStatus: "not_confirmed",
      cacheAgeHours: Math.floor((now - cachedProviderData!.at) / 3600000),
      matches: resultMatches,
    });
  } catch (error) {
    console.error("sync-bookmaker-odds:", error);
    return response({
      status: "provider_error", source: PROVIDER, capturedAt,
      message: error instanceof Error ? error.message : "Error consultando la fuente de cuotas.",
      matches: [],
    });
  }
});
