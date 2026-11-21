import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const API_BASE = "https://api.oddspapi.io/v4";
const PROVIDER = "OddsPapi";
const BOOKMAKERS = ["bet365", "betfair-ex"] as const;
const BOOK_NAMES: Record<string, string> = {
  bet365: "Bet365",
  "betfair-ex": "Betfair Exchange",
};
const FILTER = BOOKMAKERS.join(",");
const CORS = {
  "Access-Control-Allow-Origin": "https://apuestas-europeas.vercel.app",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let lastProviderCall = 0;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}
function allowedKey(req: Request) {
  const supplied = req.headers.get("apikey") ?? "";
  const legacy = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  let publishable: string[] = [];
  try {
    const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    if (raw) publishable = Object.values(JSON.parse(raw)).filter((x): x is string => typeof x === "string");
  } catch { /* optional configuration */ }
  return !!supplied && (supplied === legacy || publishable.includes(supplied));
}
function historyPreview(book: any): any[] {
  const rows: any[] = [];
  for (const [marketId, market] of Object.entries(book?.markets ?? {}) as any[]) {
    for (const [outcomeId, outcome] of Object.entries(market?.outcomes ?? {}) as any[]) {
      for (const [playerId, value] of Object.entries(outcome?.players ?? {}) as any[]) {
        const entries = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
        for (const entry of entries) {
          const price = Number(entry?.price);
          if (!Number.isFinite(price) || price <= 1 || !entry?.createdAt) continue;
          rows.push({
            marketId: String(marketId), outcomeId: String(outcomeId), playerId: String(playerId),
            createdAt: String(entry.createdAt), price,
            limit: Number.isFinite(Number(entry.limit)) ? Number(entry.limit) : null,
            active: entry.active === true,
            exchangeMeta: entry.exchangeMeta ?? null,
          });
        }
      }
    }
  }
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20);
}
function countEntries(book: any): number {
  let count = 0;
  for (const market of Object.values(book?.markets ?? {}) as any[]) {
    for (const outcome of Object.values(market?.outcomes ?? {}) as any[]) {
      for (const playerValue of Object.values(outcome?.players ?? {}) as any[]) {
        if (Array.isArray(playerValue)) count += playerValue.length;
        else if (playerValue && typeof playerValue === "object") count += 1;
      }
    }
  }
  return count;
}
function dbUrl(path: string) {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) throw new Error("Falta SUPABASE_URL.");
  return base.replace(/\/$/, "") + "/rest/v1/" + path;
}
function dbHeaders(serviceKey: string, extra: Record<string, string> = {}) {
  return {
    apikey: serviceKey,
    Authorization: "Bearer " + serviceKey,
    "Content-Type": "application/json",
    ...extra,
  };
}
async function dbGet(path: string, serviceKey: string) {
  const res = await fetch(dbUrl(path), { headers: dbHeaders(serviceKey) });
  const body = await res.text();
  if (!res.ok) throw new Error("Supabase REST " + res.status + ": " + body.slice(0, 250));
  return body ? JSON.parse(body) : [];
}
async function dbPost(path: string, rows: unknown, serviceKey: string, prefer = "return=minimal") {
  const res = await fetch(dbUrl(path), {
    method: "POST",
    headers: dbHeaders(serviceKey, { Prefer: prefer }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error("Supabase REST " + res.status + ": " + (await res.text()).slice(0, 300));
}
async function fetchHistorical(fixtureId: string, apiKey: string, etag?: string) {
  const wait = Math.max(0, 5000 - (Date.now() - lastProviderCall));
  if (wait) await sleep(wait);
  lastProviderCall = Date.now();
  const url = new URL(API_BASE + "/historical-odds");
  url.searchParams.set("fixtureId", fixtureId);
  url.searchParams.set("bookmakers", FILTER);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (res.status === 304) return { notModified: true, body: null, etag: res.headers.get("etag") ?? etag ?? null };
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* invalid JSON */ }
  if (!res.ok) {
    const code = parsed?.error?.code ?? parsed?.code ?? "";
    const message = parsed?.error?.message ?? parsed?.message ?? text.slice(0, 180);
    throw new Error("OddsPapi HTTP " + res.status + (code ? " [" + code + "]" : "") + ": " + String(message).slice(0, 220));
  }
  if (!parsed || typeof parsed !== "object") throw new Error("OddsPapi devolvió un histórico sin JSON válido.");
  return { notModified: false, body: parsed, etag: res.headers.get("etag") };
}

const requestWindow = new Map<string, { start: number; count: number }>();
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ status: "method_not_allowed" }, 405);
  if (!allowedKey(req)) return reply({ status: "unauthorized" }, 401);
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  const window = requestWindow.get(ip);
  if (window && now - window.start < 10 * 60 * 1000 && window.count >= 2) {
    return reply({ status: "rate_limited", message: "Límite de histórico: espera 10 minutos antes de repetir consultas." }, 429);
  }
  if (!window || now - window.start >= 10 * 60 * 1000) requestWindow.set(ip, { start: now, count: 1 });
  else requestWindow.set(ip, { start: window.start, count: window.count + 1 });

  const apiKey = Deno.env.get("ODDSPAPI_API_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!apiKey) return reply({ status: "not_configured", message: "Falta ODDSPAPI_API_KEY en los secretos de Supabase." }, 503);
  if (!serviceKey) return reply({ status: "not_configured", message: "Falta SUPABASE_SERVICE_ROLE_KEY en Supabase." }, 503);

  let input: any;
  try { input = await req.json(); } catch { return reply({ status: "invalid_json" }, 400); }
  const ids = Array.isArray(input?.partidoIds)
    ? [...new Set(input.partidoIds.map(Number).filter((n: number) => Number.isSafeInteger(n) && n > 0))].slice(0, 5)
    : [];
  if (!ids.length) return reply({ status: "invalid_input", message: "Envía partidoIds con entre 1 y 5 IDs internos de CANCHA." }, 400);

  try {
    const idFilter = ids.join(",");
    const mappings = await dbGet(
      "oddspapi_fixture_map?select=fixture_id,partido_id,equipo_local,equipo_visitante,kickoff,status_id&partido_id=in.(" + idFilter + ")",
      serviceKey,
    );
    if (!Array.isArray(mappings) || !mappings.length) {
      return reply({ status: "no_fixture_mapping", message: "No hay fixtureId de OddsPapi guardados para esos partidos. Actualiza primero las cuotas actuales.", matches: [] });
    }

    const results: any[] = [];
    for (const mapping of mappings) {
      const fixtureId = String(mapping.fixture_id);
      const finished = Number(mapping.status_id) === 2 || Number(mapping.status_id) === 3;
      const cachedRows = await dbGet(
        "oddspapi_historical_cache?select=etag,response_body,fetched_at,status_id&fixture_id=eq." +
        encodeURIComponent(fixtureId) + "&bookmaker_filter=eq." + encodeURIComponent(FILTER) + "&limit=1",
        serviceKey,
      );
      const cached = Array.isArray(cachedRows) ? cachedRows[0] : null;
      let fetched: any;
      const cacheFresh = !!cached?.response_body && Number.isFinite(Date.parse(String(cached.fetched_at))) &&
        Date.now() - Date.parse(String(cached.fetched_at)) < 15 * 60 * 1000;
      const cacheHit = !finished && cacheFresh;
      try {
        fetched = cacheHit
          ? { notModified: true, body: null, etag: cached?.etag ?? null }
          : await fetchHistorical(fixtureId, apiKey, finished && cached?.etag ? String(cached.etag) : undefined);
      } catch (error) {
        results.push({
          partidoId: Number(mapping.partido_id), fixtureId,
          home: mapping.equipo_local, away: mapping.equipo_visitante,
          status: "provider_error", message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      let body: any;
      let notModified = false;
      if (fetched.notModified) {
        if (!cached?.response_body) {
          results.push({ partidoId: Number(mapping.partido_id), fixtureId, status: "cache_miss_304" });
          continue;
        }
        body = cached.response_body;
        notModified = true;
      } else {
        body = fetched.body;
        const cacheRow = {
          fixture_id: fixtureId,
          bookmaker_filter: FILTER,
          etag: fetched.etag,
          response_body: body,
          fetched_at: new Date().toISOString(),
          status_id: Number(mapping.status_id ?? 0),
        };
        await dbPost("oddspapi_historical_cache?on_conflict=fixture_id,bookmaker_filter", [cacheRow], serviceKey, "resolution=merge-duplicates,return=minimal");
      }

      const books = body?.bookmakers ?? {};
      const summaries: any[] = [];
      for (const slug of BOOKMAKERS) {
        const history = books[slug];
        if (!history) {
          summaries.push({ bookmaker: BOOK_NAMES[slug], slug, entries: 0, saved: false, status: "no_data" });
          continue;
        }
        const entries = countEntries(history);
        let saved = false;
        if (!notModified && entries > 0) {
          await dbPost("cuotas_historicas_oddspapi", [{
            partido_id: Number(mapping.partido_id),
            fixture_id: fixtureId,
            bookmaker_slug: slug,
            bookmaker_name: BOOK_NAMES[slug],
            history,
            fetched_at: new Date().toISOString(),
            source: PROVIDER,
          }], serviceKey);
          saved = true;
        }
        summaries.push({ bookmaker: BOOK_NAMES[slug], slug, entries, saved, status: entries ? "ok" : "empty_history", preview: historyPreview(history) });
      }
      results.push({
        partidoId: Number(mapping.partido_id), fixtureId,
        home: mapping.equipo_local, away: mapping.equipo_visitante,
        status: cacheHit ? "cached" : notModified ? "not_modified" : "ok",
        etag: fetched.etag ?? cached?.etag ?? null,
        fetchedAt: notModified ? cached?.fetched_at : new Date().toISOString(),
        bookmakers: summaries,
      });
    }

    return reply({
      status: "ok", source: PROVIDER, endpoint: "/v4/historical-odds",
      cooldownMs: 5000, maxPartidosPorLlamada: 5,
      matchesRequested: ids.length, matchesFound: mappings.length,
      notMapped: ids.filter((id: number) => !mappings.some((m: any) => Number(m.partido_id) === id)),
      results,
    });
  } catch (error) {
    console.error("sync-historical-odds:", error);
    return reply({ status: "internal_error", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});
