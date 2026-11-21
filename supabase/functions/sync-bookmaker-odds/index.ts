import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const API_BASE = "https://api.oddspapi.io/v4";
const PROVIDER = "OddsPapi";
const BOOKS = [
  { api: "betfair-es", key: "Betfair", display: "Betfair" },
  { api: "bet365-es", key: "Bet365", display: "Bet365" },
];
const TARGET_TOURNAMENTS = new Map([
  ["laliga", "spain"],
  ["premier-league", "england"],
  ["bundesliga", "germany"],
  ["serie-a", "italy"],
  ["ligue-1", "france"],
  ["uefa-champions-league", "international-clubs"],
  ["uefa-europa-league", "international-clubs"],
]);
const CACHE_TTL = 24 * 60 * 60 * 1000;
const EMPTY_CACHE_TTL = 15 * 60 * 1000;
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
  markets: Array<{marketId:string;marketName:string;marketType:string;period:string;handicap:number|null;playerProp:boolean;outcomes:Array<{outcomeId:string;outcomeName:string;playerId:string;playerName:string|null;price:number|null;active:boolean;changedAt:string|null}>}>;
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
function normalizeBook(book: any, capturedAt: string, catalogue: Map<string, any>): NormalizedBook {
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
    markets: normalizeAllMarkets(book, capturedAt, catalogue),
  };
}
function normalizeAllMarkets(book: any, capturedAt: string, catalogue: Map<string, any>) {
  const rows: NormalizedBook["markets"] = [];
  for (const [marketId, market] of Object.entries(book?.markets ?? {}) as Array<[string, any]>) {
    if (!market || market.marketActive === false) continue;
    const meta = catalogue.get(String(marketId)) ?? {};
    const outcomes: NormalizedBook["markets"][number]["outcomes"] = [];
    for (const [outcomeId, outcome] of Object.entries(market.outcomes ?? {}) as Array<[string, any]>) {
      for (const [playerId, player] of Object.entries(outcome?.players ?? {}) as Array<[string, any]>) {
        const price = validPrice(player?.price);
        const changedAt = typeof player?.changedAt === "string" && Number.isFinite(Date.parse(player.changedAt)) ? player.changedAt : null;
        outcomes.push({
          outcomeId: String(outcomeId),
          outcomeName: String(meta.outcomes?.find((x: any) => String(x.outcomeId) === String(outcomeId))?.outcomeName ?? player?.bookmakerOutcomeId ?? outcomeId),
          playerId: String(playerId),
          playerName: typeof player?.playerName === "string" ? player.playerName : null,
          price: player?.active === false ? null : price,
          active: player?.active !== false && market.marketActive !== false,
          changedAt,
        });
      }
    }
    if (outcomes.length) rows.push({
      marketId: String(marketId),
      marketName: String(meta.marketName ?? "Mercado " + marketId),
      marketType: String(meta.marketType ?? "unknown"),
      period: String(meta.period ?? "unknown"),
      handicap: Number.isFinite(Number(meta.handicap)) ? Number(meta.handicap) : null,
      playerProp: meta.playerProp === true,
      outcomes,
    });
  }
  return rows;
}
function quoteRows(matchId: number, books: Record<string, NormalizedBook>) {
  const rows: any[] = [];
  for (const book of BOOKS) {
    const data = books[book.key];
    if (!data) continue;
    for (const market of data.markets ?? []) {
      const line = market.handicap != null ? " (" + market.handicap + ")" : "";
      const period = market.period && market.period !== "unknown" ? " · " + market.period : "";
      for (const outcome of market.outcomes ?? []) {
        if (outcome.price == null || !Number.isFinite(outcome.price) || outcome.price <= 1 || !outcome.active) continue;
        rows.push({
          partido_id: matchId,
          casa_apuestas: book.display,
          mercado: market.marketName + line + period,
          seleccion: outcome.outcomeName + (outcome.playerName ? " · " + outcome.playerName : ""),
          cuota: outcome.price,
          proveedor: PROVIDER,
          hora_captura: outcome.changedAt ?? data.updatedAt ?? data.capturedAt,
        });
      }
    }
  }
  return rows;
}
const endpointLastCall = new Map<string, number>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function apiGet(path: string, params: Record<string, string>, apiKey: string) {
  const url = new URL(API_BASE + path);
  url.searchParams.set("apiKey", apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = endpointLastCall.get(path) ?? 0;
    const wait = Math.max(0, 1100 - (Date.now() - previous));
    if (wait) await sleep(wait);
    endpointLastCall.set(path, Date.now());
    const result = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
    const raw = await result.text();
    let parsed: any = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    if (result.ok) {
      if (!parsed) throw new Error("OddsPapi no devolvió JSON válido.");
      return parsed;
    }
    const code = parsed?.error?.code ?? parsed?.code ?? "";
    const message = String(parsed?.error?.message ?? parsed?.message ?? parsed?.details ?? "Respuesta no válida del proveedor").slice(0, 220);
    lastError = "OddsPapi HTTP " + result.status + (code ? " [" + code + "]" : "") + ": " + message;
    if (result.status === 429 && code === "RATE_LIMITED" && attempt < 2) {
      const retryMs = Number(parsed?.error?.retryMs ?? parsed?.retryMs ?? 1200);
      await sleep(Math.max(1100, Number.isFinite(retryMs) ? retryMs + 200 : 1400));
      continue;
    }
    throw new Error(lastError);
  }
  throw new Error(lastError || "OddsPapi: no se pudo completar la consulta.");
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
let cachedMarketCatalogue: { at: number; byId: Map<string, any> } | null = null;

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
  const forceRefresh = payload?.force === true;
  const matches = input.filter(m =>
    Number.isSafeInteger(Number(m?.id)) &&
    typeof m?.home === "string" && m.home.trim() &&
    typeof m?.away === "string" && m.away.trim() &&
    typeof m?.kickoff === "string" && Number.isFinite(Date.parse(m.kickoff))
  ).map(m => ({ id: Number(m.id), home: m.home.trim(), away: m.away.trim(), kickoff: m.kickoff }));
  if (!matches.length) return response({ status: "ok", source: PROVIDER, capturedAt, matches: [] });

  try {
    if (!cachedMarketCatalogue || now - cachedMarketCatalogue.at >= CACHE_TTL) {
      const marketPayload = await apiGet("/markets", { language: "es" }, apiKey);
      const marketRows = asArray(marketPayload);
      cachedMarketCatalogue = { at: now, byId: new Map(marketRows.map((m: any) => [String(m.marketId), m])) };
    }

    if (!cachedTournaments || now - cachedTournaments.at >= CACHE_TTL) {
      const tournamentPayload = await apiGet("/tournaments", { sportId: "10", language: "en" }, apiKey);
      const tournaments = asArray(tournamentPayload);
      const selected = tournaments
        .filter(t => {
          const slug = String(t?.tournamentSlug ?? "");
          const category = String(t?.categorySlug ?? "");
          const expectedCategory = TARGET_TOURNAMENTS.get(slug);
          const available = Number(t?.futureFixtures ?? 0) + Number(t?.upcomingFixtures ?? 0);
          return !!expectedCategory && category === expectedCategory && available > 0;
        })
        .sort((a, b) =>
          (Number(b?.futureFixtures ?? 0) + Number(b?.upcomingFixtures ?? 0)) -
          (Number(a?.futureFixtures ?? 0) + Number(a?.upcomingFixtures ?? 0))
        );
      const unique = new Map<string, number>();
      for (const t of selected) {
        const slug = String(t.tournamentSlug);
        if (!unique.has(slug)) unique.set(slug, Number(t.tournamentId));
      }
      const ids = [...unique.values()].filter(id => Number.isSafeInteger(id) && id > 0);
      if (!ids.length) throw new Error("OddsPapi no ofrece torneos con partidos futuros para las competiciones configuradas.");
      cachedTournaments = { at: now, ids };
    }

    if (forceRefresh) cachedProviderData = null;
    if (!cachedProviderData || now - cachedProviderData.at >= (cachedProviderData.fixtures.length ? CACHE_TTL : EMPTY_CACHE_TTL)) {
      const allFixtures: any[] = [];
      const bookErrors: Record<string, string> = {};
      const ids = cachedTournaments.ids;
      for (const book of BOOKS) {
        const batchSize = book.api.startsWith("betfair") ? 1 : 3;
        for (let i = 0; i < ids.length; i += batchSize) {
          const tournamentIds = ids.slice(i, i + batchSize).join(",");
          let oddsPayload: any;
          try {
            oddsPayload = await apiGet("/odds-by-tournaments", {
              tournamentIds, bookmaker: book.api, language: "en", verbosity: "3",
            }, apiKey);
          } catch (error) {
            const message = String(error instanceof Error ? error.message : error);
            // OddsPapi devuelve 404 FIXTURE_NOT_FOUND cuando ese lote no tiene
            // partidos con cuotas para esa casa. Es ausencia de datos, no fallo global.
            if (message.includes("404 [FIXTURE_NOT_FOUND]")) {
              console.info("OddsPapi sin fixtures para lote", { bookmaker: book.api, tournamentIds });
              continue;
            }
            if (message.includes("429 [RATE_LIMITED]")) {
              bookErrors[book.display] = message;
              console.warn("OddsPapi limitado temporalmente; se omiten los siguientes lotes de esta casa.", { bookmaker: book.api });
              break;
            }
            throw error;
          }
          for (const fixture of asArray(oddsPayload)) {
            const existing = allFixtures.find(x => String(x.fixtureId) === String(fixture.fixtureId));
            if (!existing) allFixtures.push(fixture);
            else existing.bookmakerOdds = { ...(existing.bookmakerOdds ?? {}), ...(fixture.bookmakerOdds ?? {}) };
          }
        }
      }
      cachedProviderData = { at: now, fixtures: allFixtures };
      (globalThis as any).__oddsBookErrors = bookErrors;
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
        if (raw) normalized[book.key] = normalizeBook(raw, capturedAt, cachedMarketCatalogue!.byId);
      }
      return {
        id: match.id, home: match.home, away: match.away, kickoff: match.kickoff,
        matched: true, providerEventId: String(fixture.fixtureId),
        bookmakers: normalized,
      };
    });

    // Persistir el vínculo CANCHA -> fixtureId OddsPapi para consultar históricos.
    const projectUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const fixtureMappings = resultMatches.filter(x => x.matched && x.providerEventId).map(x => ({
      fixture_id: String(x.providerEventId),
      partido_id: Number(x.id),
      equipo_local: String(x.home),
      equipo_visitante: String(x.away),
      kickoff: String(x.kickoff),
      status_id: Number((cachedProviderData!.fixtures.find(f => String(f.fixtureId) === String(x.providerEventId)) as any)?.statusId ?? 0),
      proveedor: PROVIDER,
      updated_at: new Date().toISOString(),
    }));
    if (fixtureMappings.length && projectUrl && serviceKey) {
      const mappingSave = await fetch(projectUrl.replace(/\/$/, "") + "/rest/v1/oddspapi_fixture_map?on_conflict=fixture_id", {
        method: "POST",
        headers: {
          apikey: serviceKey, Authorization: "Bearer " + serviceKey,
          "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(fixtureMappings),
      });
      if (!mappingSave.ok) console.error("No se pudieron guardar los fixtureId históricos:", mappingSave.status, (await mappingSave.text()).slice(0, 300));
    }

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

    const quoteCount = savedRows.length;
    const matchedCount = resultMatches.filter(x => x.matched).length;
    return response({
      status: "ok", source: PROVIDER, capturedAt, stored,
      bookmakerNames: BOOKS.map(x => x.display),
      marketCoverage: "all_markets_returned_by_provider",
      diagnostics: {
        tournamentsQueried: cachedTournaments.ids.length,
        providerFixtures: cachedProviderData!.fixtures.length,
        matchedMatches: matchedCount,
        verifiedQuotes: quoteCount,
        bookmakerErrors: (globalThis as any).__oddsBookErrors ?? {},
      },
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
