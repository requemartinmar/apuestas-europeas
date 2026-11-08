// ============================================================================
// Bot Quant v4.4 — Supabase Edge Function (Webhook de Telegram)
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { evaluatePredictionOutcome, findUniqueFixtureMatch } from "./settlement.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY") ?? "";
const API_FOOTBALL_KEY = Deno.env.get("API_FOOTBALL_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TZ = "Europe/Madrid";
const ODDS_URL = "https://api.the-odds-api.com/v4/sports";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORY_DAYS = 1095;
const MIN_GAMES_KNOWN = 5;
const SEARCH_PROMPT = "🔍 Escribe el nombre del equipo:";
const FETCH_TIMEOUT_MS = 15000;

const LEAGUES: Record<string, [string, string]> = {
  "⭐ Champions League": ["soccer_uefa_champs_league", "Champions League"],
  "🟠 Europa League": ["soccer_uefa_europa_league", "Europa League"],
  "🟢 Conference League": ["soccer_uefa_europa_conference_league", "Conference League"],
  "🇪🇸 LaLiga": ["soccer_spain_la_liga", "LaLiga"],
  "🇬🇧 Premier": ["soccer_epl", "Premier League"],
  "🇮🇹 Serie A": ["soccer_italy_serie_a", "Serie A"],
  "🇩🇪 Bundesliga": ["soccer_germany_bundesliga", "Bundesliga"],
};

const LEAGUE_ID_MAP: Record<string, number> = {
  "soccer_uefa_champs_league": 2,
  "soccer_uefa_europa_league": 3,
  "soccer_spain_la_liga": 140,
  "soccer_epl": 39,
  "soccer_italy_serie_a": 135,
  "soccer_germany_bundesliga": 78,
  "soccer_uefa_europa_conference_league": 848,
};

const TIERS: Record<string, [string, number]> = {
  "🟢 Fácil (~1.50)": ["Fácil", 1.5],
  "🟡 Medio (~2.00)": ["Medio", 2.0],
  "🔴 Difícil (~2.50)": ["Difícil", 2.5],
};

const KEYBOARD = {
  keyboard: [
    Object.keys(TIERS),
    ["📅 Partidos de Hoy", "⚽ Cancha", "🏆 Top 3 Cancha"],
    ["🎯 BOMBA REMATES"],
    ["🔎 Buscar partido"],
    ["🟠 Europa League", "⭐ Champions League"],
    ["🇪🇸 LaLiga", "🇬🇧 Premier", "🟢 Conference League"],
    ["🇮🇹 Serie A", "🇩🇪 Bundesliga"],
    ["🔍 Buscar Equipo"],
  ].map((row) => row.map((text) => ({ text }))),
  resize_keyboard: true,
};

function esc(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeName(name: string): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const COUNTRY_CODES = new Set([
  "eng", "esp", "ita", "ger", "fra", "por", "ned", "bel", "sui", "sco", "den", "aut", "nor", "srb",
  "ukr", "tur", "gre", "aze", "mco", "cro", "cze", "cyp", "isr", "kaz", "pol", "swe", "svk", "svn",
  "hun", "bul", "rou", "lux", "irl", "nir", "wal", "fin", "isl", "blr", "mda", "mkd", "alb", "bih",
  "mlt", "geo", "arm", "lva", "ltu", "est", "and",
]);
const STOP_TOKENS = new Set([
  "fc", "cf", "sc", "ac", "as", "afc", "ssc", "bc", "bsc", "fk", "kv", "sk", "pae", "sfp", "osc",
  "club", "de", "cd", "ud", "sd", "rcd", "ca", "the", "rc", "sv", "vfb", "vfl", "fsv", "and",
]);
const TEAM_ALIASES: Record<string, string> = {
  "ath madrid": "atletico madrid", "ath bilbao": "athletic bilbao",
  "athletic club": "athletic bilbao", "betis": "real betis",
  "sociedad": "real sociedad", "celta": "celta vigo",
  "vallecano": "rayo vallecano", "espanol": "espanyol",
  "oviedo": "real oviedo", "valladolid": "real valladolid",
  "deportivo alaves": "alaves", "internazionale milano": "inter",
  "inter milan": "inter", "bayern munchen": "bayern munich",
  "stade brestois": "brest", "sport lisboa e benfica": "benfica",
  "sporting clube portugal": "sporting cp", "psv eindhoven": "psv",
  "feyenoord rotterdam": "feyenoord", "kobenhavn": "copenhagen",
  "crvena zvezda": "red star belgrade", "olympiakos": "olympiacos",
  "qarabag agdam": "qarabag", "psg": "paris saint germain",
  "sporting lisbon": "sporting cp", "racing lens": "lens",
  "olympiakos piraeus": "olympiacos", "red bull salzburg": "salzburg",
  "rb salzburg": "salzburg", "aek athens": "aek",
  "manchester united": "man utd", "man united": "man utd",
  "tottenham hotspur": "tottenham", "wolverhampton wanderers": "wolves",
  "borussia dortmund": "dortmund", "borussia monchengladbach": "monchengladbach",
  "rb leipzig": "leipzig", "bayer 04 leverkusen": "leverkusen",
  "ac milan": "milan",
};

function teamKey(name: string): string {
  const plain = (name ?? "")
    .toLowerCase()
    .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ł/g, "l").replace(/đ/g, "d")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ").trim();
  let tokens = plain.split(" ").filter((t) => t && !/^\d+$/.test(t));
  if (tokens.length > 1 && COUNTRY_CODES.has(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
  const stripped = tokens.filter((t) => !STOP_TOKENS.has(t));
  const base = (stripped.length > 0 ? stripped : tokens).join(" ");
  return (TEAM_ALIASES[base] ?? base).replace(/ /g, "");
}

function pct(x: number): string { return (x * 100).toFixed(1); }
function madridDate(d: Date): string { return d.toLocaleDateString("en-CA", { timeZone: TZ }); }
function fmtTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("es-ES", {
    timeZone: TZ, day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

type Json = any;

function poissonPmf(lam: number, maxGoals: number): number[] {
  const probs = [Math.exp(-lam)];
  for (let k = 1; k <= maxGoals; k++) probs.push((probs[k - 1] * lam) / k);
  return probs;
}

interface TeamStats { attack: number; defense: number; weightSum: number; games: number; }
interface Prediction { lamH: number; lamA: number; p1: number; px: number; p2: number; pOver25: number; pBtts: number; }
const NEUTRAL: TeamStats = { attack: 1, defense: 1, weightSum: 0, games: 0 };

class RollingPoisson {
  matchCount = 0;
  sumHome = 0;
  sumAway = 0;
  totalWeight = 0;
  teams = new Map<string, TeamStats>();
  halfLife: number;
  referenceDate: Date | null = null;
  hasData = true;

  constructor(halfLifeDays = 365) { this.halfLife = halfLifeDays; }

  get avgHome(): number { return this.totalWeight > 0 ? Math.max(0.5, this.sumHome / this.totalWeight) : 1.3; }
  get avgAway(): number { return this.totalWeight > 0 ? Math.max(0.5, this.sumAway / this.totalWeight) : 1.0; }

  private team(norm: string): TeamStats {
    let t = this.teams.get(norm);
    if (!t) { t = { attack: 1, defense: 1, weightSum: 0, games: 0 }; this.teams.set(norm, t); }
    return t;
  }

  private calcWeight(matchDate?: string): number {
    if (!matchDate || !this.referenceDate) return 1.0;
    const d = new Date(matchDate);
    if (isNaN(d.getTime())) return 1.0;
    const deltaDays = Math.max(0, Math.floor((this.referenceDate.getTime() - d.getTime()) / 86400000));
    return Math.exp(-Math.LN2 * (deltaDays / this.halfLife));
  }

  private resolveCache = new Map<string, string | null>();

  private resolve(name: string): string | null {
    const k = teamKey(name);
    if (this.teams.has(k)) return k;
    if (k.length < 5) return null;
    if (this.resolveCache.has(k)) return this.resolveCache.get(k) ?? null;
    const cands = [...this.teams.keys()].filter((t) => t.length >= 5 && (t.includes(k) || k.includes(t)));
    const found = cands.length === 1 ? cands[0] : null;
    this.resolveCache.set(k, found);
    return found;
  }

  private stats(name: string): TeamStats {
    const key = this.resolve(name);
    return (key ? this.teams.get(key) : undefined) ?? NEUTRAL;
  }

  isKnown(name: string): boolean { return this.stats(name).games >= MIN_GAMES_KNOWN; }

  observe(home: string, away: string, goalsHome: number, goalsAway: number, matchDate?: string) {
    const weight = this.calcWeight(matchDate);
    const ah = this.avgHome; const aa = this.avgAway;
    const th = this.team(teamKey(home)); const ta = this.team(teamKey(away));
    const alpha = 0.05;
    th.attack += weight * alpha * (goalsHome / ah - th.attack);
    th.defense += weight * alpha * (goalsAway / aa - th.defense);
    ta.attack += weight * alpha * (goalsAway / aa - ta.attack);
    ta.defense += weight * alpha * (goalsHome / ah - ta.defense);
    th.weightSum += weight; ta.weightSum += weight;
    th.games += 1; ta.games += 1;
    this.matchCount += 1;
    this.sumHome += goalsHome * weight; this.sumAway += goalsAway * weight;
    this.totalWeight += weight;
  }

  calibrateFromXG(xgData: Map<string, { xgFor: number; xgAgainst: number; games: number }>) {
    for (const [key, stats] of xgData) {
      const team = this.teams.get(key);
      if (!team || stats.games < 5) continue;
      team.attack = (team.attack + (stats.xgFor / stats.games) / this.avgHome) / 2;
      team.defense = (team.defense + (stats.xgAgainst / stats.games) / this.avgAway) / 2;
    }
  }

  predict(home: string, away: string): Prediction {
    const th = this.stats(home); const ta = this.stats(away);
    const lamH = Math.max(0.1, this.avgHome * th.attack * ta.defense);
    const lamA = Math.max(0.1, this.avgAway * ta.attack * th.defense);
    const maxG = 12;
    const ph = poissonPmf(lamH, maxG); const pa = poissonPmf(lamA, maxG);
    let p1 = 0, px = 0, p2 = 0, pOver = 0, pBtts = 0;
    for (let i = 0; i < ph.length; i++) {
      for (let j = 0; j < pa.length; j++) {
        const p = ph[i] * pa[j];
        if (i > j) p1 += p; else if (i === j) px += p; else p2 += p;
        if (i + j >= 3) pOver += p;
        if (i > 0 && j > 0) pBtts += p;
      }
    }
    const total = p1 + px + p2;
    if (total === 0) return { lamH, lamA, p1: 1/3, px: 1/3, p2: 1/3, pOver25: 0.5, pBtts: 0.5 };
    return { lamH, lamA, p1: p1/total, px: px/total, p2: p2/total, pOver25: pOver/total, pBtts: pBtts/total };
  }
}

async function loadStatsBombXG(): Promise<any> {
  const out = new Map<string, { xgFor: number; xgAgainst: number; games: number }>();
  const { data } = await supabase.from("statsbomb_xg").select("team_key, xg_for, xg_against, games");
  if (data) {
    for (const r of data) out.set(r.team_key, { xgFor: r.xg_for, xgAgainst: r.xg_against, games: r.games });
  }
  return out;
}

async function fetchJson(url: string): Promise<Json | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function seasonStartYears(): number[] {
  const now = new Date();
  const y = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return [y - 2, y - 1, y];
}
function seasonLabel(y: number): string { return `${y}-${String((y + 1) % 100).padStart(2, "0")}`; }

async function fetchFixturesToday(leagueName: string): Promise<any[]> {
  const today = madridDate(new Date());
  const now = Date.now();
  const files: [string, string][] = [
    ["es.1", "LaLiga"], 
    ["en.1", "Premier League"], 
    ["it.1", "Serie A"],
    ["de.1", "Bundesliga"]
  ];
  const out: any[] = [];
  const y = seasonStartYears()[2];

  for (const [f, league] of files) {
    if (league !== leagueName) continue;
    const data = await fetchJson(`https://raw.githubusercontent.com/openfootball/football.json/master/${seasonLabel(y)}/${f}.json`);
    if (!data) continue;
    const list: Json[] = Array.isArray(data.matches) ? data.matches : (data.rounds ?? []).flatMap((r: Json) => r.matches ?? []);
    const name = (t: Json): string => (typeof t === "string" ? t : t?.name ?? "");
    for (const m of list) {
      if (typeof m.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(m.date)) continue;
      const played = Array.isArray(m.score?.ft) || m.score1 != null;
      if (played) continue;
      const start = new Date(`${m.date.slice(0, 10)}T15:00:00Z`);
      if (start.getTime() < now - 6 * 3600 * 1000 || start.getTime() > now + 30 * 3600 * 1000) continue;
      if (madridDate(start) !== today) continue;
      const home = name(m.team1).trim();
      const away = name(m.team2).trim();
      if (!home || !away) continue;
      out.push({ league_name: leagueName, home, away, start_utc: start.toISOString() });
    }
  }
  return out;
}

async function fetchEventsFromApiFootball(sportKey: string): Promise<any[]> {
  if (!API_FOOTBALL_KEY) return [];
  const leagueId = LEAGUE_ID_MAP[sportKey];
  if (!leagueId) return [];
  const today = new Date().toISOString().split("T")[0];
  const url = `https://v3.football.api-sports.io/odds?league=${leagueId}&season=${new Date().getFullYear()}&date=${today}`;
  try {
    const res = await fetch(url, { headers: { "x-apisports-key": API_FOOTBALL_KEY }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.response || []).map((item: any) => ({
      home_team: item.teams?.home?.name || "Local",
      away_team: item.teams?.away?.name || "Visitante",
      commence_time: item.fixture?.date || new Date().toISOString(),
      bookmakers: (item.bookmakers || []).map((bm: any) => ({
        title: bm.name,
        markets: (bm.bets || []).map((bet: any) => {
          let key = "other";
          let point: number | undefined = undefined;
          if (bet.name.includes("Winner") || bet.name.includes("Ganador")) {
            key = "h2h";
          } else if (bet.name.includes("Over/Under") || bet.name.includes("Más/Menos") || bet.name.includes("Goals")) {
            key = "totals";
            const match = bet.name.match(/(\d+\.?\d*)/);
            if (match) point = parseFloat(match[1]);
          }
          return {
            key,
            outcomes: (bet.values || []).map((v: any) => ({ 
              name: v.value, 
              price: parseFloat(v.odd) || 0,
              point: key === "totals" ? point : undefined 
            })),
          };
        }).filter((m: any) => m.key !== "other"),
      })),
    }));
  } catch { return []; }
}

const memCache = new Map<string, { time: number; data: any[] }>();
const alternateOddsCache = new Map<string, { time: number; data: any[] }>();

async function fetchEvents(sportKey: string, leagueName: string): Promise<any[]> {
  const mem = memCache.get(sportKey);
  if (mem && Date.now() - mem.time < CACHE_TTL_MS) return mem.data;

  let events: any[] = [];
  if (ODDS_API_KEY) {
    try {
      const url = new URL(`${ODDS_URL}/${sportKey}/odds/`);
      url.searchParams.set("apiKey", ODDS_API_KEY);
      url.searchParams.set("regions", "eu");
      url.searchParams.set("markets", "h2h,totals");
      url.searchParams.set("oddsFormat", "decimal");
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) events = (await res.json()).map((ev: any) => ({ ...ev, _oddsApi: true }));
    } catch { /* pasar al fallback */ }
  }

  if (events.length === 0 && API_FOOTBALL_KEY) {
    events = await fetchEventsFromApiFootball(sportKey);
  }

  if (events.length === 0) {
    const fixtures = await fetchFixturesToday(leagueName);
    events = fixtures.map(f => ({
      home_team: f.home,
      away_team: f.away,
      commence_time: f.start_utc,
      bookmakers: [],
      _noOdds: true,
    }));
  }

  if (events.length > 0) {
    memCache.set(sportKey, { time: Date.now(), data: events });
  }
  return events;
}

async function fetchAlternateTotals(sportKey: string, eventId: string): Promise<any[]> {
  const cached = alternateOddsCache.get(eventId);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.data;
  if (!ODDS_API_KEY || !eventId) return [];
  try {
    const url = new URL(`${ODDS_URL}/${sportKey}/events/${eventId}/odds/`);
    url.searchParams.set("apiKey", ODDS_API_KEY);
    url.searchParams.set("regions", "eu");
    url.searchParams.set("markets", "alternate_totals");
    url.searchParams.set("oddsFormat", "decimal");
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn("alternate_totals_unavailable", { sportKey, status: res.status });
      alternateOddsCache.set(eventId, { time: Date.now(), data: [] });
      return [];
    }
    const data = await res.json();
    const bookmakers = Array.isArray(data?.bookmakers) ? data.bookmakers : [];
    alternateOddsCache.set(eventId, { time: Date.now(), data: bookmakers });
    return bookmakers;
  } catch (error) {
    console.warn("alternate_totals_fetch_failed", { sportKey, error: String(error).slice(0, 180) });
    return [];
  }
}

async function enrichComboMarkets(matches: any[]) {
  // Solo se consultan hasta seis eventos con probabilidades teóricas >70%.
  // alternate_totals es un mercado adicional de coste superior en The Odds API.
  const ranked = matches
    .filter((m) => m.eventId && m.sportKey)
    .map((m) => {
      const lambda = Number(m.lambdas?.[0] ?? 0) + Number(m.lambdas?.[1] ?? 0);
      const pOver05 = poissonOverTotal(lambda, 0.5);
      const pUnder35 = 1 - poissonOverTotal(lambda, 3.5);
      const pUnder45 = 1 - poissonOverTotal(lambda, 4.5);
      return { m, score: Math.max(pOver05, pUnder35, pUnder45) };
    })
    .filter((x) => x.score > 0.70)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  await Promise.all(ranked.map(async ({ m }) => {
    const extraBooks = await fetchAlternateTotals(m.sportKey, m.eventId);
    for (const extra of extraBooks) {
      const current = (m.bookmakers ?? []).find((b: any) => String(b.title) === String(extra.title));
      if (current) {
        current.markets = [...(current.markets ?? []), ...(extra.markets ?? [])];
      } else {
        m.bookmakers.push(extra);
      }
    }
  }));
}

function parseEvent(ev: any, league: string, model: RollingPoisson) {
  const home = ev.home_team; const away = ev.away_team;
  const start = new Date(ev.commence_time);
  if (isNaN(start.getTime())) return null;

  const hasOdds = ev.bookmakers && ev.bookmakers.length > 0 && !ev._noOdds;
  const pred = model.predict(home, away);
  
  return {
    league, home, away, start, time: fmtTime(start),
    eventId: ev._oddsApi && typeof ev.id === "string" ? ev.id : null,
    modelProbs: [pred.p1, pred.px, pred.p2],
    modelGoals: [pred.pOver25, pred.pBtts],
    lambdas: [pred.lamH, pred.lamA],
    known: model.isKnown(home) && model.isKnown(away),
    noOdds: !hasOdds,
    bookmakers: Array.isArray(ev.bookmakers) ? ev.bookmakers : [],
  };
}

const PREDICTION_MODEL_VERSION = "league-model-candidate-2026-11-08";

async function logModelPredictions(matches: any[]): Promise<void> {
  if (!matches.length) return;
  const rows: any[] = [];
  for (const m of matches) {
    const groupId = crypto.randomUUID();
    const fixtureKey = [
      String(m.eventId ?? ""),
      String(m.sportKey ?? ""),
      normalizeName(String(m.home ?? "")),
      normalizeName(String(m.away ?? "")),
      new Date(m.start).toISOString(),
    ].join("|");
    const [pHome, pDraw, pAway] = m.modelProbs;
    const [pOver25, pBtts] = m.modelGoals;
    const common = {
      prediction_group_id: groupId,
      source: "quant-telegram",
      model_version: PREDICTION_MODEL_VERSION,
      sport_key: m.sportKey ?? null,
      competition: m.league ?? null,
      event_id: m.eventId ?? null,
      home_team: m.home,
      away_team: m.away,
      commence_time: new Date(m.start).toISOString(),
      prediction_type: "market",
      prediction_payload: {
        model_probs_1x2: { home: pHome, draw: pDraw, away: pAway },
        model_goals: { over_2_5: pOver25, both_teams_to_score: pBtts },
        expected_goals: { home: m.lambdas?.[0], away: m.lambdas?.[1] },
        captured_from: "getTodayMatches",
      },
    };
    const markets = [
      { market_key: "h2h", selection: "home", probability: pHome },
      { market_key: "h2h", selection: "draw", probability: pDraw },
      { market_key: "h2h", selection: "away", probability: pAway },
      { market_key: "totals", selection: "over_2.5", line: 2.5, probability: pOver25 },
      { market_key: "btts", selection: "yes", probability: pBtts },
    ];
    for (const market of markets) {
      rows.push({
        ...common,
        idempotency_key: [fixtureKey, market.market_key, market.selection].join("|"),
        market_key: market.market_key,
        selection: market.selection,
        line: market.line ?? null,
        model_probability: market.probability,
      });
    }
  }
  const { error } = await supabase.from("quant_prediction_log")
    .upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) throw new Error("No se pudieron registrar las predicciones: " + error.message);
}


type PredictionSettlementSummary = {
  checked: number;
  settled: number;
  won: number;
  lost: number;
  unmatched: number;
  ambiguous: number;
  unsupported: number;
};

async function settleModelPredictions(): Promise<PredictionSettlementSummary> {
  const summary: PredictionSettlementSummary = {
    checked: 0, settled: 0, won: 0, lost: 0, unmatched: 0, ambiguous: 0, unsupported: 0,
  };
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: pending, error: pendingError } = await supabase
    .from("quant_prediction_log")
    .select("id,sport_key,home_team,away_team,commence_time,market_key,selection,line")
    .eq("result_status", "pending")
    .lt("commence_time", cutoff)
    .order("commence_time", { ascending: true })
    .limit(1000);
  if (pendingError) throw new Error("No se pudieron leer pronósticos pendientes: " + pendingError.message);
  if (!pending?.length) return summary;

  summary.checked = pending.length;
  const competitionBySport: Record<string, string> = {
    soccer_spain_la_liga: "140",
    soccer_epl: "39",
    soccer_italy_serie_a: "135",
    soccer_germany_bundesliga: "78",
    soccer_uefa_champs_league: "2",
  };
  const eligible = pending.filter((p: any) => Boolean(competitionBySport[String(p.sport_key ?? "")]));
  summary.unsupported = pending.length - eligible.length;
  if (!eligible.length) return summary;

  const kickoffTimes = eligible
    .map((p: any) => new Date(p.commence_time).getTime())
    .filter((n: number) => Number.isFinite(n));
  if (!kickoffTimes.length) return summary;
  const marginMs = 24 * 60 * 60 * 1000;
  const from = new Date(Math.min(...kickoffTimes) - marginMs).toISOString();
  const to = new Date(Math.max(...kickoffTimes) + marginMs).toISOString();
  const competitionIds = [...new Set(eligible.map((p: any) => competitionBySport[String(p.sport_key)]))];

  const { data: fixtures, error: fixturesError } = await supabase
    .from("partidos")
    .select("id,competid_id,fecha_utc,equipo_local_id,equipo_visitante_id,goles_local,goles_visitante,estado,fuente")
    .in("competid_id", competitionIds)
    .eq("estado", "FINISHED")
    .not("goles_local", "is", null)
    .not("goles_visitante", "is", null)
    .gte("fecha_utc", from)
    .lte("fecha_utc", to)
    .limit(2000);
  if (fixturesError) throw new Error("No se pudieron leer resultados finalizados: " + fixturesError.message);
  if (!fixtures?.length) {
    summary.unmatched = eligible.length;
    return summary;
  }

  const teamIds = [...new Set(fixtures.flatMap((f: any) => [f.equipo_local_id, f.equipo_visitante_id]))];
  const { data: teams, error: teamsError } = await supabase
    .from("equipos")
    .select("id,nombre")
    .in("id", teamIds);
  if (teamsError) throw new Error("No se pudieron leer los nombres de los equipos: " + teamsError.message);
  const teamNameById = new Map((teams ?? []).map((t: any) => [String(t.id), String(t.nombre ?? "")]));

  const fixtureIndex = new Map<string, any[]>();
  for (const f of fixtures) {
    const home = teamNameById.get(String(f.equipo_local_id)) ?? "";
    const away = teamNameById.get(String(f.equipo_visitante_id)) ?? "";
    if (!home || !away || !f.fecha_utc) continue;
    const key = [String(f.competid_id), teamKey(home), teamKey(away)].join("|");
    const list = fixtureIndex.get(key) ?? [];
    list.push({ ...f, home_name: home, away_name: away });
    fixtureIndex.set(key, list);
  }

  for (const p of eligible) {
    const competitionId = competitionBySport[String(p.sport_key)];
    const key = [competitionId, teamKey(String(p.home_team ?? "")), teamKey(String(p.away_team ?? ""))].join("|");
    const fixtureMatch = findUniqueFixtureMatch(fixtureIndex.get(key) ?? [], p.commence_time);
    if (fixtureMatch.status === "missing") {
      summary.unmatched++;
      continue;
    }
    if (fixtureMatch.status === "ambiguous") {
      summary.ambiguous++;
      continue;
    }

    const fixture = fixtureMatch.fixture;
    const homeScore = Number(fixture.goles_local);
    const awayScore = Number(fixture.goles_visitante);
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) {
      summary.unmatched++;
      continue;
    }

    const actual = evaluatePredictionOutcome(
      String(p.market_key ?? ""),
      String(p.selection ?? ""),
      p.line == null ? null : Number(p.line),
      homeScore,
      awayScore,
    );
    if (actual === null) {
      summary.unsupported++;
      continue;
    }

    const outcome = actual === 1;
    const { error: updateError } = await supabase
      .from("quant_prediction_log")
      .update({
        result_status: outcome ? "won" : "lost",
        settled_at: new Date().toISOString(),
        home_score: homeScore,
        away_score: awayScore,
        actual_value: actual,
        outcome,
        settlement_source: String(fixture.fuente ?? "football-data.org"),
        settlement_payload: {
          provider: String(fixture.fuente ?? "football-data.org"),
          match_id: fixture.id,
          competition_id: fixture.competid_id,
          kickoff_utc: fixture.fecha_utc,
          home_team_verified: fixture.home_name,
          away_team_verified: fixture.away_name,
          status: fixture.estado,
        },
      })
      .eq("id", p.id)
      .eq("result_status", "pending");
    if (updateError) throw new Error("Error liquidando pronóstico " + p.id + ": " + updateError.message);
    summary.settled++;
    if (outcome) summary.won++;
    else summary.lost++;
  }
  return summary;
}

async function getTodayMatches(buttons: string[] | null) {
  try {
    const settlement = await settleModelPredictions();
    if (settlement.settled > 0) console.info("prediction_log_settlement", settlement);
  } catch (error) {
    console.error("prediction_log_settlement_failed", error instanceof Error ? error.message : String(error));
  }
  const now = new Date();
  const today = madridDate(now);
  const targets = (buttons ?? Object.keys(LEAGUES)).filter((b) => Object.hasOwn(LEAGUES, b));
  const errors:string[]=[];
  const results = await Promise.all(targets.map(async (btn) => {
    const [key, name] = LEAGUES[btn];
    const model = await getModelForSport(key);
    if(!model){errors.push(name+": histórico suficiente no disponible; se omite para no fabricar probabilidades.");return [];}
    const events = await fetchEvents(key, name);
    return events.map((ev) => {
      const parsed = parseEvent(ev, name, model);
      if (!parsed) return null;
      (parsed as any).sportKey = key;
      if (!parsed.known) {
        errors.push(name + ": " + parsed.home + " — " + parsed.away +
          " omitido: histórico insuficiente o equivalencia de equipo no reconocida (mínimo " +
          MIN_GAMES_KNOWN + " partidos por equipo).");
        return null;
      }
      return parsed;
    }).filter((m): m is any => m !== null && m.start > now && madridDate(m.start) === today);
  }));
  const matches = results.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
  try {
    await logModelPredictions(matches);
  } catch (error) {
    console.error("prediction_log_write_failed", error instanceof Error ? error.message : String(error));
    errors.push("No se pudieron guardar todas las predicciones para su evaluación; revisa los registros de la función.");
  }
  return { matches, errors };
}


function poissonOverTotal(lambda: number, line: number): number {
  let p = Math.exp(-lambda), cumulative = p;
  for (let k = 1; k <= 12; k++) {
    p *= lambda / k;
    if (k <= Math.floor(line)) cumulative += p;
  }
  return Math.max(0, Math.min(1, 1 - cumulative));
}
type BetCandidate = { fixture:string; match:any; label:string; probability:number; odds:number; bookmaker:string };
function dailyCandidates(matches:any[]):BetCandidate[] {
  const best = new Map<string,BetCandidate>();
  for (const m of matches) {
    const fixture = normalizeName(m.home)+"|"+normalizeName(m.away)+"|"+m.start.toISOString();
    const [pHome,pDraw,pAway] = m.modelProbs;
    const [pOver25] = m.modelGoals;
    const [lh,la] = m.lambdas;
    const pOver15 = poissonOverTotal(lh+la,1.5);
    const add = (label:string, probability:number, odds:number, bookmaker:string) => {
      if (!(probability > 0.70) || !Number.isFinite(odds) || odds <= 1.01) return;
      const key = fixture+"|"+label, old = best.get(key);
      if (!old || odds > old.odds) best.set(key,{fixture,match:m,label,probability,odds,bookmaker});
    };
    for (const bm of m.bookmakers ?? []) for (const market of bm.markets ?? []) {
      if (market.key === "h2h") for (const o of market.outcomes ?? []) {
        const n = normalizeName(String(o.name ?? ""));
        let p:number|null=null, label="";
        if (n===normalizeName(m.home)||n==="home") {p=pHome;label="Gana "+m.home;}
        else if (n===normalizeName(m.away)||n==="away") {p=pAway;label="Gana "+m.away;}
        else if (["draw","empate","tie"].includes(n)) {p=pDraw;label="Empate";}
        if (p!==null) add(label,p,Number(o.price),String(bm.title??"Casa"));
      }
      if (market.key === "totals" || market.key === "alternate_totals") for (const o of market.outcomes ?? []) {
        const name=String(o.name??"");
        const matchLine=name.match(/([0-9]+(?:\.[0-9]+)?)/);
        const point=Number(o.point??market.point??(matchLine?matchLine[1]:NaN));
        if (![0.5,1.5,2.5,3.5,4.5].includes(point)) continue;
        const over=/^over/i.test(name)||/más|mas/i.test(name);
        const under=/^under/i.test(name)||/menos/i.test(name);
        if (!over&&!under) continue;
        const pOver=poissonOverTotal(lh+la,point);
        add((over?"Más de ":"Menos de ")+String(point).replace(".",",")+" goles",
          over?pOver:1-pOver,Number(o.price),String(bm.title??"Casa"));
      }
    }
  }
  return [...best.values()].sort((a,b)=>b.probability-a.probability).slice(0,28);
}
async function sendDailyTips(chatId:number|string,matches:any[]) {
  const tips:any[]=[];
  for (const m of matches) {
    const [h,d,a]=m.modelProbs, [o25,btts]=m.modelGoals;
    const options=[{name:"Local",p:h},{name:"Empate",p:d},{name:"Visitante",p:a},{name:"Más de 2,5 goles",p:o25},{name:"Ambos marcan",p:btts}]
      .filter(x=>x.p>0.70).sort((x,y)=>y.p-x.p);
    if(options.length) tips.push("⚽ <b>"+esc(m.home)+" — "+esc(m.away)+"</b>\n"+options.map(x=>"• "+x.name+": <b>"+pct(x.p)+"%</b>").join("\n"));
  }
  if(tips.length) await telegram("sendMessage",{chat_id:chatId,parse_mode:"HTML",
    text:"💡 <b>TIPS DEL MODELO · SELECCIONES SUPERIORES AL 70%</b>\n\n"+tips.join("\n\n")+"\n\n<i>Revisa cuota, alineaciones y contexto. Son estimaciones, no apuestas seguras.</i>"});
}
async function sendDailyCombo(chatId:number|string,target:number,label:string) {
  await telegram("sendMessage",{chat_id:chatId,text:"🔎 Buscando partidos de hoy y mercados con probabilidad superior al 70%…"});
  const {matches,errors}=await getTodayMatches(null);
  if(!matches.length){
    await telegram("sendMessage",{chat_id:chatId,text:"⚠️ No hay partidos analizables con histórico disponible hoy."+(errors.length?"\n\nCompeticiones omitidas:\n"+errors.join("\n"):"")});
    return;
  }
  await enrichComboMarkets(matches);
  const candidates=dailyCandidates(matches);
  if(!candidates.length) {
    await telegram("sendMessage",{chat_id:chatId,text:"⚠️ Hoy no encuentro selecciones que superen estrictamente el 70% y tengan cuotas reales disponibles. No voy a inventar cuotas ni forzar una combinada."});
    return;
  }
  let best:any=null;
  const consider=(legs:BetCandidate[])=>{
    // Una combinada debe contener al menos dos partidos distintos.
    if(legs.length<2 || legs.length>4)return;
    if(new Set(legs.map(x=>x.fixture)).size!==legs.length)return;
    const odds=legs.reduce((v,x)=>v*x.odds,1);
    const probability=legs.reduce((v,x)=>v*x.probability,1);
    const diff=Math.abs(odds-target);
    if(diff>target*0.12)return;
    if(!best||diff<best.diff-0.0001||(Math.abs(diff-best.diff)<0.0001&&probability>best.probability))
      best={legs,odds,probability,diff};
  };
  for(let i=0;i<candidates.length;i++){
    for(let j=i+1;j<candidates.length;j++){
      if(candidates[i].fixture===candidates[j].fixture)continue;
      consider([candidates[i],candidates[j]]);
      for(let k=j+1;k<candidates.length;k++){
        if(candidates[k].fixture===candidates[i].fixture||candidates[k].fixture===candidates[j].fixture)continue;
        consider([candidates[i],candidates[j],candidates[k]]);
        for(let l=k+1;l<candidates.length;l++){
          if(candidates[l].fixture===candidates[i].fixture||candidates[l].fixture===candidates[j].fixture||candidates[l].fixture===candidates[k].fixture)continue;
          consider([candidates[i],candidates[j],candidates[k],candidates[l]]);
        }
      }
    }
  }
  if(!best) {
    const top=candidates.slice(0,5).map(x=>"• "+esc(x.match.home)+" — "+esc(x.match.away)+": "+esc(x.label)+" · "+(x.probability*100).toFixed(1)+"% · cuota "+x.odds.toFixed(2)).join("\n");
    await telegram("sendMessage",{chat_id:chatId,text:"⚠️ No hay una combinada de al menos dos partidos distintos cercana a cuota "+target.toFixed(2)+" con los filtros pedidos.\n\nMejores selecciones disponibles (>70%):\n"+top+"\n\nNo se fuerza una combinada si no encaja con la cuota objetivo."});
    return;
  }
  const lines=best.legs.map((x:BetCandidate,i:number)=>(i+1)+". <b>"+esc(x.match.home)+" — "+esc(x.match.away)+"</b>\n   "+esc(x.label)+"\n   Probabilidad modelo: <b>"+(x.probability*100).toFixed(1)+"%</b>\n   Cuota: <b>"+x.odds.toFixed(2)+"</b> · "+esc(x.bookmaker)).join("\n\n");
  await telegram("sendMessage",{chat_id:chatId,parse_mode:"HTML",
    text:"🎯 <b>COMBINADA OBJETIVO "+esc(label)+"</b>\n\n"+lines+"\n\n💶 Cuota total aproximada: <b>"+best.odds.toFixed(2)+"</b>\n📊 Probabilidad conjunta estimada: <b>"+(best.probability*100).toFixed(1)+"%</b>\n\n✅ Cada selección supera el 70% según el modelo.\n⚠️ La probabilidad conjunta es menor que la individual y se estima multiplicando probabilidades como si los partidos fueran independientes. No es una apuesta segura ni una garantía. Comprueba que las cuotas sigan vigentes antes de decidir."});
}

function formatMatch(m: any): string {
  const [local, empate, visitante] = m.modelProbs;
  const [over25, ambos] = m.modelGoals;
  const [golesLocal, golesVisitante] = m.lambdas;
  return [
    `🏆 <b>${esc(m.league)}</b>`,
    `⚽ <b>${esc(m.home)} — ${esc(m.away)}</b>`,
    `🕒 ${esc(m.time)}`,
    "",
    "📊 <b>PROBABILIDAD DEL MODELO</b>",
    `🏠 Local: <b>${pct(local)}%</b>`,
    `🤝 Empate: <b>${pct(empate)}%</b>`,
    `✈️ Visitante: <b>${pct(visitante)}%</b>`,
    "",
    "🥅 <b>MERCADOS DE GOLES</b>",
    `Más de 2,5 goles: <b>${pct(over25)}%</b>`,
    `Marcan ambos: <b>${pct(ambos)}%</b>`,
    "",
    `🎯 <b>Goles esperados:</b> ${golesLocal.toFixed(2)} — ${golesVisitante.toFixed(2)}`,
    `📚 Histórico de ambos equipos: ${m.known ? "suficiente" : "limitado"}`,
    "<i>Son estimaciones estadísticas, no cuotas ni garantías.</i>",
  ].join("\n");
}

async function telegram(method: string, payload: Record<string, unknown>) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN no está configurado en Supabase.");
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  let result: any = null;
  try { result = await response.json(); } catch { /* respuesta no JSON */ }
  if (!response.ok || result?.ok !== true) {
    const description = String(result?.description ?? response.statusText ?? "Error desconocido").slice(0, 300);
    console.error("telegram_api_error", { method, status: response.status, error_code: result?.error_code ?? null, description });
    throw new Error(`Telegram ${method} rechazado: ${description}`);
  }
  return result;
}

const quantModelCache = new Map<string,{at:number;model:RollingPoisson}>();
const MODEL_PAGE_SIZE = 1000;

async function fetchHistoricalLeague(leagueCode:string):Promise<any[]> {
 const rows:any[]=[];
 for(let from=0; ; from+=MODEL_PAGE_SIZE){
  const {data,error}=await supabase.from("historical_matches")
   .select("match_date,home_team,away_team,home_goals,away_goals")
   .eq("league_code",leagueCode).order("match_date",{ascending:true})
   .range(from,from+MODEL_PAGE_SIZE-1);
  if(error)throw new Error("Histórico "+leagueCode+": "+error.message);
  const page=data??[];rows.push(...page);
  if(page.length<MODEL_PAGE_SIZE)break;
 }
 return rows;
}
async function fetchQuantCompetition(competition:string):Promise<any[]> {
 const rows:any[]=[];
 for(let from=0; ; from+=MODEL_PAGE_SIZE){
  const {data,error}=await supabase.from("quant_historical_matches")
   .select("fecha_local,home_original,away_original,goles_home,goles_away")
   .eq("competicion",competition).order("fecha_local",{ascending:true})
   .range(from,from+MODEL_PAGE_SIZE-1);
  if(error)throw new Error("Histórico Quant "+competition+": "+error.message);
  const page=data??[];rows.push(...page);
  if(page.length<MODEL_PAGE_SIZE)break;
 }
 return rows;
}
function addRowsToModel(model:RollingPoisson,rows:any[],kind:"historical"|"quant"){
 for(const r of rows){
  const home=kind==="historical"?r.home_team:r.home_original;
  const away=kind==="historical"?r.away_team:r.away_original;
  const gh=kind==="historical"?r.home_goals:r.goles_home;
  const ga=kind==="historical"?r.away_goals:r.goles_away;
  const date=kind==="historical"?r.match_date:r.fecha_local;
  if(home&&away&&gh!=null&&ga!=null&&Number.isFinite(Number(gh))&&Number.isFinite(Number(ga))){
   model.observe(String(home),String(away),Number(gh),Number(ga),String(date??""));
  }
 }
}
async function getModelForSport(sportKey:string):Promise<RollingPoisson|null>{
 const cached=quantModelCache.get(sportKey);
 if(cached&&Date.now()-cached.at<MODEL_TTL_MS)return cached.model;
 const model=new RollingPoisson(365);model.referenceDate=new Date();
 if(sportKey==="soccer_spain_la_liga"){
  const [oldRows,currentRows]=await Promise.all([
   fetchQuantCompetition("LaLiga"),fetchHistoricalLeague("SP1")
  ]);
  const dedup=new Map<string,any>();
  for(const r of oldRows){
   const key=[String(r.fecha_local??"").slice(0,10),teamKey(String(r.home_original??"")),teamKey(String(r.away_original??""))].join("|");
   dedup.set(key,{...r,_kind:"quant"});
  }
  for(const r of currentRows){
   const key=[String(r.match_date??"").slice(0,10),teamKey(String(r.home_team??"")),teamKey(String(r.away_team??""))].join("|");
   dedup.set(key,{...r,_kind:"historical"});
  }
  const merged=[...dedup.values()].sort((a,b)=>String(a.match_date??a.fecha_local).localeCompare(String(b.match_date??b.fecha_local)));
  for(const r of merged) addRowsToModel(model,[r],r._kind);
 }else if(sportKey==="soccer_epl"||sportKey==="soccer_italy_serie_a"||sportKey==="soccer_germany_bundesliga"){
  const code=sportKey==="soccer_epl"?"E0":sportKey==="soccer_italy_serie_a"?"I1":"D1";
  addRowsToModel(model,await fetchHistoricalLeague(code),"historical");
 }else if(sportKey==="soccer_uefa_champs_league"){
  addRowsToModel(model,await fetchQuantCompetition("Champions League"),"quant");
 }else{
  return null;
 }
 if(!model.matchCount)return null;
 quantModelCache.set(sportKey,{at:Date.now(),model});
 return model;
}
function mean(v:any[]):number|null{const a=v.filter(x=>x!=null&&Number.isFinite(Number(x))).map(Number);return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;}
function pois(l:number):number[]{const p=[Math.exp(-l)];for(let i=1;i<=10;i++)p[i]=p[i-1]*l/i;return p;}
async function cancha(chatId:number|string,mode:"menu"|"top3"|"search",term=""){
 const now=new Date(),end=new Date(now.getTime()+10*86400000);
 const {data:ms,error:me}=await supabase.from("partidos").select("id,fecha_utc,equipo_local_id,equipo_visitante_id,competid_id,equipo_local:equipos!partidos_equipo_local_id_fkey(nombre),equipo_visitante:equipos!partidos_equipo_visitante_id_fkey(nombre),competicion:competiciones!partidos_competid_id_fkey(nombre)").gte("fecha_utc",now.toISOString()).lte("fecha_utc",end.toISOString()).order("fecha_utc",{ascending:true}).limit(200);
 if(me)throw new Error("Cancha partidos: "+me.message);if(!ms?.length){await telegram("sendMessage",{chat_id:chatId,text:"No hay partidos próximos en Cancha."});return;}
 const ids=[...new Set(ms.flatMap((m:any)=>[String(m.equipo_local_id),String(m.equipo_visitante_id)]))];
 const {data:als,error:ae}=await supabase.from("equipo_alias").select("equipo_id,hist_league,hist_team").in("equipo_id",ids);if(ae)throw new Error("Cancha equivalencias: "+ae.message);
 const amap=new Map((als??[]).map((a:any)=>[String(a.equipo_id),a]));const codes=[...new Set((als??[]).map((a:any)=>a.hist_league).filter(Boolean))];
 const hist=new Map<string,any[]>(),base=new Map<string,{h:number;a:number}>();
 await Promise.all(codes.map(async(c:any)=>{const {data,error}=await supabase.from("historical_matches").select("match_date,home_team,away_team,home_goals,away_goals,home_shots_on_target,away_shots_on_target,home_corners,away_corners,home_yellow,away_yellow,home_red,away_red").eq("league_code",c).lt("match_date",now.toISOString().slice(0,10)).order("match_date",{ascending:false}).limit(1500);if(error)throw new Error("Cancha histórico "+c+": "+error.message);hist.set(c,data??[]);base.set(c,{h:mean((data??[]).map((x:any)=>x.home_goals))??1.45,a:mean((data??[]).map((x:any)=>x.away_goals))??1.2});}));
 const out:any[]=[];
 for(const m of ms){const ah=amap.get(String(m.equipo_local_id)),aa=amap.get(String(m.equipo_visitante_id));if(!ah||!aa||ah.hist_league!==aa.hist_league)continue;const rows=hist.get(ah.hist_league)??[],cut=String(m.fecha_utc).slice(0,10);
  const team=(name:string,venue:string)=>{const all=rows.filter((x:any)=>x.match_date<cut&&(x.home_team===name||x.away_team===name)).slice(0,12),at=all.filter((x:any)=>venue==="home"?x.home_team===name:x.away_team===name).slice(0,8);const val=(r:any,k:string)=>{const h=r.home_team===name;if(k==="gf")return h?r.home_goals:r.away_goals;if(k==="ga")return h?r.away_goals:r.home_goals;if(k==="corner")return h?r.home_corners:r.away_corners;if(k==="sot")return h?r.home_shots_on_target:r.away_shots_on_target;if(k==="card"){const y=h?r.home_yellow:r.away_yellow,z=h?r.home_red:r.away_red;return y==null&&z==null?null:Number(y??0)+Number(z??0);}return null;};const metric=(k:string)=>{const x=mean(all.map(r=>val(r,k))),y=mean(at.map(r=>val(r,k)));return y!=null&&at.length>=3&&x!=null?.7*y+.3*x:y??x;};return {n:all.length,gf:metric("gf"),ga:metric("ga"),corner:metric("corner"),sot:metric("sot"),card:metric("card")};};
  const h=team(ah.hist_team,"home"),a=team(aa.hist_team,"away");if(h.n<5||a.n<5||h.gf==null||h.ga==null||a.gf==null||a.ga==null)continue;const b=base.get(ah.hist_league)??{h:1.45,a:1.2},lh=Math.max(.15,.45*h.gf+.45*a.ga+.1*b.h),la=Math.max(.15,.45*a.gf+.45*h.ga+.1*b.a),ph=pois(lh),pa=pois(la);let o15=0,o25=0,bt=0,w=0,d=0,l=0,best={p:-1,h:0,a:0};
  for(let i=0;i<ph.length;i++)for(let j=0;j<pa.length;j++){const q=ph[i]*pa[j];if(i+j>=2)o15+=q;if(i+j>=3)o25+=q;if(i&&j)bt+=q;if(i>j)w+=q;else if(i===j)d+=q;else l+=q;if(q>best.p)best={p:q,h:i,a:j};}
  out.push({m,h,a,lh,la,score:(o25*.4+bt*.35+o15*.25)*100,o15:o15*100,o25:o25*100,bt:bt*100,w:w*100,d:d*100,l:l*100,best});
 }
 let chosen=out.sort((x,y)=>y.score-x.score);if(mode==="search"){const q=normalizeName(term);chosen=chosen.filter(x=>normalizeName(x.m.equipo_local?.nombre??"").includes(q)||normalizeName(x.m.equipo_visitante?.nombre??"").includes(q));}else if(mode==="top3")chosen=chosen.slice(0,3);else chosen=chosen.slice(0,5);
 if(!chosen.length){await telegram("sendMessage",{chat_id:chatId,text:"No hay encuentros con histórico individual suficiente para este filtro."});return;}
 const fmt=(v:number|null|undefined)=>v==null?"—":Number(v).toFixed(1);
 const msg=chosen.map((x,i)=>{
  const m=x.m,home=esc(m.equipo_local?.nombre??"Local"),away=esc(m.equipo_visitante?.nombre??"Visitante");
  return [
   (mode==="top3"?"🏅 <b>TOP "+(i+1)+"</b> · ":"")+"🏆 <b>"+esc(m.competicion?.nombre??"Cancha")+"</b> · "+esc(fmtTime(new Date(m.fecha_utc))),
   "⚽ <b>"+home+" — "+away+"</b>",
   "🎯 Marcador más probable: <b>"+x.best.h+" — "+x.best.a+"</b>",
   "🥅 Goles esperados: "+x.lh.toFixed(2)+" — "+x.la.toFixed(2),
   "",
   "📊 <b>PROBABILIDAD 1X2</b>",
   "🏠 Local: <b>"+x.w.toFixed(1)+"%</b>",
   "🤝 Empate: <b>"+x.d.toFixed(1)+"%</b>",
   "✈️ Visitante: <b>"+x.l.toFixed(1)+"%</b>",
   "",
   "⚽ <b>MERCADOS DE GOLES</b>",
   "+1,5 goles: <b>"+x.o15.toFixed(1)+"%</b>",
   "+2,5 goles: <b>"+x.o25.toFixed(1)+"%</b>",
   "Ambos marcan: <b>"+x.bt.toFixed(1)+"%</b>",
   "",
   "📈 <b>MEDIA RECIENTE POR PARTIDO</b>",
   "Remates a puerta (local / visitante): "+fmt(x.h.sot)+" / "+fmt(x.a.sot),
   "Córners (local / visitante): "+fmt(x.h.corner)+" / "+fmt(x.a.corner),
   "Tarjetas (local / visitante): "+fmt(x.h.card)+" / "+fmt(x.a.card),
   "📚 Muestra: "+x.h.n+" partidos local · "+x.a.n+" partidos visitante",
   "📈 Índice orientativo: <b>"+x.score.toFixed(1)+"/100</b>"
  ].join("\n");
 }).join("\n\n━━━━━━━━━━━━━━\n\n");
 await telegram("sendMessage",{chat_id:chatId,text:(mode==="top3"?"🏆 <b>TOP 3 CANCHA</b>":"⚽ <b>CANCHA · PARTIDOS PRÓXIMOS</b>")+"\n\n"+msg+"\n\n<i>Datos históricos y estimaciones orientativas; no son garantías ni recomendaciones de apuesta.</i>",parse_mode:"HTML"});
}


const SHOTS_HIST_LEAGUE: Record<string,string> = {
  soccer_epl: "E0", soccer_spain_la_liga: "SP1",
  soccer_italy_serie_a: "I1", soccer_germany_bundesliga: "D1",
};
const teamShotMarketCache = new Map<string,{at:number;books:any[]}>();

function poissonOverCount(lambda:number,line:number):number {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  let p=Math.exp(-lambda),cum=p;
  for(let k=1;k<=30;k++){p*=lambda/k;if(k<=Math.floor(line))cum+=p;}
  return Math.max(0,Math.min(1,1-cum));
}
function shotsPoisson(lambda:number,line:number,over:boolean):number {
  const p=poissonOverCount(lambda,line); return over?p:1-p;
}
async function fetchTeamShotOdds(m:any):Promise<any[]> {
  if(!ODDS_API_KEY || !m.eventId || !m.sportKey) return [];
  const cached=teamShotMarketCache.get(m.eventId);
  if(cached && Date.now()-cached.at<30*60*1000) return cached.books;
  try {
    const marketUrl=new URL(ODDS_URL+"/"+m.sportKey+"/events/"+m.eventId+"/markets");
    marketUrl.searchParams.set("apiKey",ODDS_API_KEY); marketUrl.searchParams.set("regions","eu");
    const marketRes=await fetch(marketUrl,{signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    if(!marketRes.ok) return [];
    const marketData=await marketRes.json();
    const keys: string[] = [...new Set<string>((marketData?.bookmakers??[]).flatMap((b:any): string[] => (b.markets??[]).map((x:any): string => String(x.key??""))))]
      .filter((k)=>/^(alternate_)?team_(shots|shots_on_target)(_|$)/i.test(k));
    if(!keys.length){teamShotMarketCache.set(m.eventId,{at:Date.now(),books:[]});return [];}
    const oddsUrl=new URL(ODDS_URL+"/"+m.sportKey+"/events/"+m.eventId+"/odds");
    oddsUrl.searchParams.set("apiKey",ODDS_API_KEY); oddsUrl.searchParams.set("regions","eu");
    oddsUrl.searchParams.set("markets",keys.join(",")); oddsUrl.searchParams.set("oddsFormat","decimal");
    const oddsRes=await fetch(oddsUrl,{signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    if(!oddsRes.ok) return [];
    const oddsData=await oddsRes.json();
    const books=Array.isArray(oddsData?.bookmakers)?oddsData.bookmakers:[];
    teamShotMarketCache.set(m.eventId,{at:Date.now(),books}); return books;
  } catch(error) {
    console.warn("team_shots_odds_lookup_failed",{eventId:m.eventId,error:String(error).slice(0,160)});
    return [];
  }
}


const playerShotMarketCache = new Map<string,{at:number;books:any[]}>();
async function fetchPlayerShotOdds(m:any):Promise<any[]> {
  if(!ODDS_API_KEY || !m.eventId || !m.sportKey) return [];
  const cached=playerShotMarketCache.get(m.eventId);
  if(cached && Date.now()-cached.at<30*60*1000) return cached.books;
  try {
    const marketUrl=new URL(ODDS_URL+"/"+m.sportKey+"/events/"+m.eventId+"/markets");
    marketUrl.searchParams.set("apiKey",ODDS_API_KEY);
    marketUrl.searchParams.set("regions","eu");
    const marketRes=await fetch(marketUrl,{signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    if(!marketRes.ok) return [];
    const marketData=await marketRes.json();
    const keys: string[] = [...new Set<string>((marketData?.bookmakers??[]).flatMap((b:any): string[] => (b.markets??[]).map((x:any): string => String(x.key??""))))]
      .filter((k)=>/^player_shots(_alternate)?$|^player_shots_on_target(_alternate)?$/i.test(k));
    if(!keys.length){playerShotMarketCache.set(m.eventId,{at:Date.now(),books:[]});return [];}
    const oddsUrl=new URL(ODDS_URL+"/"+m.sportKey+"/events/"+m.eventId+"/odds");
    oddsUrl.searchParams.set("apiKey",ODDS_API_KEY);
    oddsUrl.searchParams.set("regions","eu");
    oddsUrl.searchParams.set("markets",keys.join(","));
    oddsUrl.searchParams.set("oddsFormat","decimal");
    const oddsRes=await fetch(oddsUrl,{signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    if(!oddsRes.ok) return [];
    const oddsData=await oddsRes.json();
    const books=Array.isArray(oddsData?.bookmakers)?oddsData.bookmakers:[];
    playerShotMarketCache.set(m.eventId,{at:Date.now(),books});
    return books;
  } catch(error) {
    console.warn("player_shots_odds_lookup_failed",{eventId:m.eventId,error:String(error).slice(0,160)});
    return [];
  }
}

function shotsTeamKey(name:string):string {
  const k=teamKey(name);
  const aliases:Record<string,string>={
    manchestercity:"mancity", nottinghamforest:"nottmforest",
    eintrachtfrankfurt:"einfrankfurt", borussiadortmund:"dortmund",
    borussiamonchengladbach:"mgladbach", bayerleverkusen:"leverkusen",
    rayovallecano:"vallecano", realbetis:"betis", realsociedad:"sociedad",
    celtavigo:"celta", espanyol:"espanol", westhamunited:"westham",
  };
  return aliases[k]??k;
}

function resolveHistoricalTeam(name:string,aliases:any[]):{league:string;team:string}|null {
  const k=teamKey(name);
  const exact=aliases.filter((a:any)=>shotsTeamKey(String(a.hist_team??""))===k);
  if(exact.length===1) return {league:String(exact[0].hist_league),team:String(exact[0].hist_team)};
  const fuzzy=aliases.filter((a:any)=>{
    const ak=teamKey(String(a.hist_team??""));
    return ak.length>=5 && k.length>=5 && (ak.includes(k)||k.includes(ak));
  });
  const unique=[...new Map(fuzzy.map((a:any)=>[String(a.hist_league)+"|"+String(a.hist_team),a])).values()];
  return unique.length===1?{league:String(unique[0].hist_league),team:String(unique[0].hist_team)}:null;
}
function historicalShotRates(rows:any[],teamName:string,venue:"home"|"away",metric:"shots"|"sot"){
  const all=rows.filter((r:any)=>r.home_team===teamName||r.away_team===teamName)
    .sort((a:any,b:any)=>String(b.match_date).localeCompare(String(a.match_date))).slice(0,12);
  const at=all.filter((r:any)=>venue==="home"?r.home_team===teamName:r.away_team===teamName).slice(0,8);
  const pick=(r:any,kind:"for"|"against")=>{
    const isHome=r.home_team===teamName;
    if(metric==="shots") return kind==="for"?(isHome?r.home_shots:r.away_shots):(isHome?r.away_shots:r.home_shots);
    return kind==="for"?(isHome?r.home_shots_on_target:r.away_shots_on_target):(isHome?r.away_shots_on_target:r.home_shots_on_target);
  };
  const blend=(kind:"for"|"against")=>{
    const overall=mean(all.map((r:any)=>pick(r,kind)));
    const venueMean=mean(at.map((r:any)=>pick(r,kind)));
    return venueMean!==null&&at.length>=3&&overall!==null?0.7*venueMean+0.3*overall:overall;
  };
  return {games:all.length,forRate:blend("for"),againstRate:blend("against")};
}
async function sendShotsBomb(chatId:number|string) {
  await telegram("sendMessage",{chat_id:chatId,text:"🎯 Revisando remates y remates a puerta con históricos y mercados reales disponibles…"});
  const {matches,errors}=await getTodayMatches(null);
  if(!matches.length){await telegram("sendMessage",{chat_id:chatId,text:"No hay partidos próximos con los que construir el análisis de remates ahora mismo."+(errors.length?"\n\nCompeticiones omitidas:\n"+errors.join("\n"):"")});return;}
  const relevant=matches.filter((m:any)=>Boolean(SHOTS_HIST_LEAGUE[m.sportKey]));
  if(!relevant.length){await telegram("sendMessage",{chat_id:chatId,text:"No hay partidos de las cuatro ligas con histórico de remates disponible (LaLiga, Premier, Serie A y Bundesliga). No completaré datos de otras competiciones con promedios ajenos."});return;}
  const {data:aliases,error:aliasError}=await supabase.from("equipo_alias").select("hist_league,hist_team");
  if(aliasError) throw new Error("No se pudieron leer las equivalencias históricas: "+aliasError.message);
  const codes=[...new Set(relevant.map((m:any)=>SHOTS_HIST_LEAGUE[m.sportKey]))];
  const histories=new Map<string,any[]>();
  await Promise.all(codes.map(async(code:string)=>{
    const {data,error}=await supabase.from("historical_matches")
      .select("match_date,home_team,away_team,home_shots,away_shots,home_shots_on_target,away_shots_on_target,source")
      .eq("league_code",code).lt("match_date",madridDate(new Date()))
      .order("match_date",{ascending:false}).limit(1800);
    if(error) throw new Error("Error leyendo histórico de remates "+code+": "+error.message);
    histories.set(code,data??[]);
  }));
  const analyses:any[]=[]; const comboCandidates:any[]=[]; const playerMarketLines:any[]=[];
  for(const m of relevant.slice(0,12)){
    const league=SHOTS_HIST_LEAGUE[m.sportKey];
    const homeAlias=resolveHistoricalTeam(m.home,aliases??[]);
    const awayAlias=resolveHistoricalTeam(m.away,aliases??[]);
    if(!homeAlias||!awayAlias||homeAlias.league!==league||awayAlias.league!==league) continue;
    const rows=histories.get(league)??[];
    const hShots=historicalShotRates(rows,homeAlias.team,"home","shots");
    const aShots=historicalShotRates(rows,awayAlias.team,"away","shots");
    const hSot=historicalShotRates(rows,homeAlias.team,"home","sot");
    const aSot=historicalShotRates(rows,awayAlias.team,"away","sot");
    if(hShots.games<5||aShots.games<5||hSot.games<5||aSot.games<5) continue;
    if(hShots.forRate===null||aShots.forRate===null||hShots.againstRate===null||aShots.againstRate===null||
       hSot.forRate===null||aSot.forRate===null||hSot.againstRate===null||aSot.againstRate===null) continue;
    const lambdaHomeShots=Math.max(0.1,0.55*hShots.forRate+0.45*aShots.againstRate);
    const lambdaAwayShots=Math.max(0.1,0.55*aShots.forRate+0.45*hShots.againstRate);
    const lambdaHomeSot=Math.max(0.1,0.55*hSot.forRate+0.45*aSot.againstRate);
    const lambdaAwaySot=Math.max(0.1,0.55*aSot.forRate+0.45*hSot.againstRate);
    analyses.push({m,lambdaHomeShots,lambdaAwayShots,lambdaHomeSot,lambdaAwaySot,
      samples:{home:hShots.games,away:aShots.games},source:"football-data.co.uk"});
    
  }
  // Consultas de cuotas separadas del cálculo estadístico y ejecutadas en paralelo.
  // Limitamos las consultas de mercados a los seis encuentros más próximos.
  const oddsBatch=analyses.slice(0,6);
  await Promise.all(oddsBatch.map(async(a:any)=>{
    const m=a.m;
    const [playerBooks,books]=await Promise.all([fetchPlayerShotOdds(m),fetchTeamShotOdds(m)]);
    for(const pb of playerBooks) for(const pm of pb.markets??[]) {
      const key=String(pm.key??"");
      const isSot=/shots_on_target/i.test(key);
      const marketLabel=isSot?"remates a puerta de jugador":"remates de jugador";
      for(const outcome of pm.outcomes??[]) {
        const price=Number(outcome.price);
        if(!Number.isFinite(price)||price<1.20) continue;
        const player=String(outcome.description??"").trim();
        const selection=String(outcome.name??"").trim();
        const point=Number(outcome.point);
        if(!player || !Number.isFinite(point)) continue;
        playerMarketLines.push({player,marketLabel,isSot,selection,point,price,bookmaker:String(pb.title??"Casa"),fixture:m.home+" — "+m.away});
      }
    }
    for(const bm of books) for(const market of bm.markets??[]){
      const isSot=/shots_on_target/i.test(String(market.key??""));
      const isShots=/shots/i.test(String(market.key??""))&&!isSot;
      if(!isSot&&!isShots) continue;
      for(const o of market.outcomes??[]){
        const outcomeName=String(o.name??"");
        const desc=String(o.description??"");
        const over=/^over\b/i.test(outcomeName),under=/^under\b/i.test(outcomeName);
        const line=Number(o.point??market.point);
        if((!over&&!under)||!Number.isFinite(line)||line<=0) continue;
        const teamText=desc||outcomeName.replace(/^(over|under)\s*/i,"").trim();
        const teamNorm=shotsTeamKey(teamText);
        let side:"home"|"away"|null=null;
        if(teamNorm===shotsTeamKey(m.home)) side="home";
        else if(teamNorm===shotsTeamKey(m.away)) side="away";
        if(!side) continue;
        const lambda=isSot?(side==="home"?a.lambdaHomeSot:a.lambdaAwaySot):(side==="home"?a.lambdaHomeShots:a.lambdaAwayShots);
        const probability=shotsPoisson(lambda,line,over),price=Number(o.price);
        if(probability>0.70&&Number.isFinite(price)&&price>=1.20){
          comboCandidates.push({fixture:normalizeName(m.home)+"|"+normalizeName(m.away)+"|"+m.start.toISOString(),
            match:m,label:teamText+" "+(isSot?"remates a puerta":"remates")+" "+(over?"más de":"menos de")+" "+line,
            probability,odds:price,bookmaker:String(bm.title??"Casa")});
        }
      }
    }
  }));
  if(!analyses.length){await telegram("sendMessage",{chat_id:chatId,text:"No hay suficientes estadísticas verificadas para los equipos de los partidos disponibles. Se necesitan al menos 5 partidos históricos por equipo y datos completos de remates y remates a puerta."});return;}
  const fmt=(n:number)=>n.toFixed(1);
  // Agrupa cuotas reales de jugadores dentro de la ficha del partido correspondiente.
  const playerGroups=new Map<string,any>();
  for(const item of playerMarketLines){
    const key=[normalizeName(item.player),item.marketLabel,item.selection,item.bookmaker,item.fixture].join("|");
    let group=playerGroups.get(key);
    if(!group){group={...item,lines:new Map<number,number>()};playerGroups.set(key,group);}
    const previous=group.lines.get(item.point);
    if(previous===undefined || item.price>previous) group.lines.set(item.point,item.price);
  }
  const playerCardsByFixture=new Map<string,any[]>();
  for(const card of playerGroups.values()){
    const list=playerCardsByFixture.get(card.fixture)??[];
    list.push(card); playerCardsByFixture.set(card.fixture,list);
  }
  const projectionBlocks=analyses.slice(0,8).map((a:any)=>{
    const m=a.m, fixture=m.home+" — "+m.away;
    const players=(playerCardsByFixture.get(fixture)??[]).sort((x:any,y:any)=>x.player.localeCompare(y.player));
    const playerText=players.length ? players.map((card:any)=>{
      const market=card.isSot?"🥅 <b>REMATES A PUERTA</b>":"🎯 <b>REMATES TOTALES</b>";
      const lines=[...card.lines.entries()].sort((x:any,y:any)=>x[0]-y[0])
        .map(([line,price]:[number,number])=>"<b>"+esc(String(line))+" → "+price.toFixed(2)+"</b>").join("  |  ");
      return "👤 <b>"+esc(card.player)+"</b> · "+market+" · <b>"+esc(card.selection.toUpperCase())+"</b>\n"+
        "📈 "+lines+"\n🏦 "+esc(card.bookmaker);
    }).join("\n") : "No hay cuotas de jugadores verificadas disponibles para este partido.";
    return "⚽ <b>"+esc(m.home)+" — "+esc(m.away)+"</b>\n"+
      "🕒 "+esc(m.time)+"\n"+
      "🎯 Remates esperados: <b>"+fmt(a.lambdaHomeShots)+" — "+fmt(a.lambdaAwayShots)+"</b>\n"+
      "🥅 A puerta esperados: <b>"+fmt(a.lambdaHomeSot)+" — "+fmt(a.lambdaAwaySot)+"</b>\n"+
      "📊 Prob. +8,5 remates: "+fmt(shotsPoisson(a.lambdaHomeShots,8.5,true)*100)+"% / "+fmt(shotsPoisson(a.lambdaAwayShots,8.5,true)*100)+"%\n"+
      "📊 Prob. +2,5 a puerta: "+fmt(shotsPoisson(a.lambdaHomeSot,2.5,true)*100)+"% / "+fmt(shotsPoisson(a.lambdaAwaySot,2.5,true)*100)+"%\n"+
      "📚 Muestra: "+a.samples.home+" partidos local · "+a.samples.away+" visitante · fuente "+a.source+
      "\n\n👥 <b>JUGADORES DEL PARTIDO</b>\n"+playerText;
  });
  const sendProjectionBlocks=async()=>{
    await telegram("sendMessage",{chat_id:chatId,parse_mode:"HTML",text:"📊 <b>RESUMEN DE REMATES</b>\nProyecciones históricas; no son cuotas."});
    for(const block of projectionBlocks){
      await telegram("sendMessage",{chat_id:chatId,parse_mode:"HTML",text:block});
    }
  };
  if(comboCandidates.length){
    const candidates=[...new Map(comboCandidates.map((x:any)=>[x.fixture+"|"+x.label,x])).values()]
      .sort((a:any,b:any)=>b.odds-a.odds).slice(0,24);
    const combos:any[]=[];
    for(let i=0;i<candidates.length;i++) for(let j=i+1;j<candidates.length;j++){
      if(candidates[i].fixture===candidates[j].fixture) continue;
      const legs=[candidates[i],candidates[j]];
      combos.push({legs,odds:legs.reduce((v:number,x:any)=>v*x.odds,1),
        probability:legs.reduce((v:number,x:any)=>v*x.probability,1)});
    }
    combos.sort((a:any,b:any)=>b.odds-a.odds);
    const top=combos.slice(0,3);
    if(top.length){
      await telegram("sendMessage",{chat_id:chatId,parse_mode:"HTML",text:"🔥 <b>BOMBA REMATES</b>\nSolo cuotas ≥ 1.20 y probabilidad estimada del modelo superior al 70%."});
      for(let i=0;i<top.length;i++){
        const c=top[i];
        const comboText="<b>COMBINADA "+(i+1)+" · CUOTA "+c.odds.toFixed(2)+"</b>\n"+
          c.legs.map((x:any,j:number)=>(j+1)+". "+esc(x.match.home)+" — "+esc(x.match.away)+"\n   "+
            esc(x.label)+" · "+esc(x.bookmaker)+" · "+x.odds.toFixed(2)+" · modelo "+fmt(x.probability*100)+"%").join("\n")+
          "\nProbabilidad conjunta orientativa: "+fmt(c.probability*100)+"%";
        await telegram("sendMessage",{chat_id:chatId,parse_mode:"HTML",text:comboText});
      }
      await telegram("sendMessage",{chat_id:chatId,parse_mode:"HTML",text:"<i>Cuotas recibidas de bookmakers mediante The Odds API. Probabilidades calculadas con Poisson sobre históricos; no son garantías. La probabilidad conjunta multiplica las probabilidades individuales y asume independencia entre partidos.</i>"});
    } else {
      await telegram("sendMessage",{chat_id:chatId,text:"No se han podido formar combinadas con partidos distintos y cuotas verificadas."});
    }
  } else {
    await telegram("sendMessage",{chat_id:chatId,parse_mode:"HTML",text:"⚠️ <b>Sin combinada de remates a cuota real</b>\nHe consultado los mercados disponibles. No hay mercados de remates de equipo que cumplan los filtros de cuota ≥ 1.20 y probabilidad estimada superior al 70%. No invento precios ni probabilidades."});
  }
  await sendProjectionBlocks();
}


async function handleUpdate(update: any) {
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text?.trim();
  if (!chatId || !text) return;

  if (text.startsWith("/start")) {
    await telegram("sendMessage", { chat_id: chatId, text: "⚽ <b>Bot Quant + Cancha</b>\nQuant: predicciones y mercados · Cancha: modelo individual por equipos.", parse_mode: "HTML", reply_markup: KEYBOARD });
    return;
  }
  if (text === "/cancha" || text === "⚽ Cancha") { await cancha(chatId,"menu"); return; }
  if (text === "/top3" || text === "🏆 Top 3 Cancha") { await cancha(chatId,"top3"); return; }
  if (text === "/remates" || text === "🎯 BOMBA REMATES") { await sendShotsBomb(chatId); return; }
  if (text.startsWith("/buscar")) { await cancha(chatId,"search",text.replace(/^\/buscar\s*/i,"")); return; }
  if (text === "🔎 Buscar partido") { await telegram("sendMessage",{chat_id:chatId,text:"Escribe /buscar seguido del nombre del equipo. Ejemplo: /buscar Real Madrid"}); return; }

  if (Object.hasOwn(TIERS,text)) {
    const [tierLabel,targetOdds]=TIERS[text];
    await sendDailyCombo(chatId,targetOdds,tierLabel);
    return;
  }

  if (text === "📅 Partidos de Hoy" || Object.hasOwn(LEAGUES, text)) {
    const buttons = Object.hasOwn(LEAGUES, text) ? [text] : null;
    await telegram("sendMessage", { chat_id: chatId, text: "🔍 Analizando partidos de hoy…" });
    const { matches, errors } = await getTodayMatches(buttons);
    if (matches.length === 0) {
      await telegram("sendMessage", { chat_id: chatId, text: "⚠️ No hay partidos programados para hoy en las ligas seleccionadas."+(errors.length?"\n\nCompeticiones omitidas:\n"+errors.join("\n"):"") });
    } else {
      for (const m of matches) {
        await telegram("sendMessage", { chat_id: chatId, text: formatMatch(m), parse_mode: "HTML" });
      }
      await sendDailyTips(chatId,matches);
      if(errors.length) await telegram("sendMessage",{chat_id:chatId,text:"ℹ️ Competiciones omitidas:\n"+errors.join("\n")});
    }
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("OK", { status: 200 });

  const cronSecretHeader = req.headers.get("x-cron-secret");
  if (CRON_SECRET && cronSecretHeader === CRON_SECRET) {
    try {
      const settlement = await settleModelPredictions();
      console.info("prediction_log_cron_settlement", settlement);
      return new Response(JSON.stringify({ ok: true, source: "cron", settlement }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      console.error("prediction_log_cron_settlement_failed", e instanceof Error ? e.stack ?? e.message : String(e));
      return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 500 });
    }
  }

  const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
  if (TELEGRAM_WEBHOOK_SECRET && secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
    console.warn("telegram_webhook_auth_failed", { headerPresent: Boolean(secretHeader), headerLength: secretHeader?.length ?? 0, configuredLength: TELEGRAM_WEBHOOK_SECRET.length });
    return new Response("Unauthorized", { status: 401 });
  }

  let update: any;
  try { update = await req.json(); } catch { return new Response("Bad Request", { status: 400 }); }

  try {
    // Esperar a que termine el procesamiento: no devolver 200 mientras el trabajo
    // de fondo pueda ser descartado por el runtime (EarlyDrop).
    await handleUpdate(update);
  } catch (err) {
    console.error("telegram_update_failed", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  // Telegram necesita un 200 para confirmar el webhook; los errores quedan
  // registrados y los fallos de envío se detectan dentro de telegram().
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});