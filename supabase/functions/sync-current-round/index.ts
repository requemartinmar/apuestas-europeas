import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * Sincroniza partidos de la jornada vigente y fechas próximas/recientes desde API-Football.
 * Programar desde Supabase Cron. La clave del proveedor y el secreto interno
 * viven en Supabase Function Secrets, nunca en el HTML ni en el navegador.
 */
const PROVIDER = "api-football";
const API_ROOT = "https://v3.football.api-sports.io";
const COMPETITIONS = [
  { slug: "laliga", providerId: "140" },
  { slug: "premier-league", providerId: "39" },
  { slug: "bundesliga", providerId: "78" },
  { slug: "serie-a", providerId: "135" },
  { slug: "champions-league", providerId: "2" },
  { slug: "europa-league", providerId: "3" },
  { slug: "conference-league", providerId: "848" },
];
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN"]);

type ProviderResponse<T> = { errors?: unknown; response?: T; results?: number };
type ProviderTeam = { id: number; name: string; logo?: string | null };
type ProviderFixture = {
  fixture: { id: number; date: string; status: { short: string }; venue?: { name?: string | null } };
  league: { round?: string | null };
  teams: { home: ProviderTeam; away: ProviderTeam };
  goals: { home: number | null; away: number | null };
  referee?: string | null;
};
type ProviderStat = { type: string; value: string | number | null };
type ProviderFixtureStats = { team: ProviderTeam; statistics: ProviderStat[] };

const env = (key: string) => Deno.env.get(key)?.trim() ?? "";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function currentSeasonStartYear(now = new Date()): number {
  const month = now.getUTCMonth() + 1;
  return month >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace("%", "").replace(",", ".").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function providerGet<T>(path: string, params: Record<string, string>) {
  const url = new URL(`${API_ROOT}/${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { "x-apisports-key": env("APISPORTS_FOOTBALL_KEY") } });
  const body = await response.json() as ProviderResponse<T>;
  if (response.status === 429) throw new Error("API_FOOTBALL_DAILY_QUOTA_REACHED");
  if (!response.ok || (Array.isArray(body.errors) && body.errors.length > 0)) {
    throw new Error(`API-Football ${path}: ${JSON.stringify(body.errors ?? response.status).slice(0, 350)}`);
  }
  return { body, remaining: response.headers.get("x-ratelimit-requests-remaining") };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env("SYNC_FUNCTION_SECRET") || request.headers.get("x-sync-secret") !== env("SYNC_FUNCTION_SECRET")) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const providerKey = env("APISPORTS_FOOTBALL_KEY");
  if (!supabaseUrl || !serviceKey || !providerKey) {
    return json({ error: "missing_function_secrets" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const seasonYear = Number(env("FOOTBALL_SEASON") || currentSeasonStartYear());
  if (!Number.isInteger(seasonYear) || seasonYear < 2000 || seasonYear > 2100) {
    return json({ error: "invalid_FOOTBALL_SEASON" }, 500);
  }

  const outcomes: Array<Record<string, unknown>> = [];
  let requestsRemaining: number | null = null;
  let runId: string | null = null;
  const { data: run, error: runInsertError } = await supabase
    .from("football_sync_runs")
    .insert({ provider: PROVIDER, season_start_year: seasonYear, sync_kind: "current-round", status: "running" })
    .select("id").single();
  if (runInsertError) return json({ error: "could_not_create_sync_run", detail: runInsertError.message }, 500);
  runId = run.id;

  try {
    for (const competition of COMPETITIONS) {
      if (requestsRemaining !== null && requestsRemaining <= 0) {
        outcomes.push({ competition: competition.slug, status: "deferred_quota" });
        continue;
      }
      let fixturesSeen = 0;
      let fixturesUpserted = 0;
      let statisticsUpserted = 0;
      let apiRequestsRemaining: string | null = null;
      try {
        const { data: dbCompetition, error: competitionError } = await supabase
          .from("football_competitions").select("id").eq("slug", competition.slug).single();
        if (competitionError) throw competitionError;

        const { error: previousSeasonError } = await supabase.from("football_seasons")
          .update({ is_current: false }).eq("competition_id", dbCompetition.id).eq("is_current", true)
          .neq("season_start_year", seasonYear);
        if (previousSeasonError) throw previousSeasonError;
        const { data: dbSeason, error: seasonError } = await supabase.from("football_seasons")
          .upsert({
            competition_id: dbCompetition.id,
            season_start_year: seasonYear,
            label: `${seasonYear}/${String(seasonYear + 1).slice(-2)}`,
            is_current: true,
            provider_season_id: String(seasonYear),
          }, { onConflict: "competition_id,season_start_year" }).select("id").single();
        if (seasonError) throw seasonError;

        const fixtureResult = await providerGet<ProviderFixture[]>("fixtures", {
          league: competition.providerId,
          season: String(seasonYear),
          timezone: "Europe/Madrid",
        });
        apiRequestsRemaining = fixtureResult.remaining;
        requestsRemaining = apiRequestsRemaining === null ? null : Number(apiRequestsRemaining);
        const allFixtures = fixtureResult.body.response ?? [];
        const now = Date.now();
        const lookBehind = now - 7 * 24 * 60 * 60 * 1000;
        const lookAhead = now + 7 * 24 * 60 * 60 * 1000;
        const providerFixtures = allFixtures.filter((item) => {
          const kickoff = Date.parse(item.fixture.date);
          const isLive = !FINISHED_STATUSES.has(item.fixture.status.short) &&
            !["NS", "TBD", "PST", "CANC", "ABD", "AWD", "WO"].includes(item.fixture.status.short);
          return (kickoff >= lookBehind && kickoff <= lookAhead) || isLive;
        });
        fixturesSeen = providerFixtures.length;
        const externalIds = providerFixtures.map((item) => String(item.fixture.id));

        const existingStats = new Map<string, { checkedAt: string | null; confirmedAt: string | null }>();
        if (externalIds.length) {
          const { data, error } = await supabase.from("football_fixtures")
            .select("provider_fixture_id,statistics_checked_at,statistics_confirmed_at")
            .eq("provider", PROVIDER).in("provider_fixture_id", externalIds);
          if (error) throw error;
          for (const row of data ?? []) existingStats.set(row.provider_fixture_id, {
            checkedAt: row.statistics_checked_at,
            confirmedAt: row.statistics_confirmed_at,
          });
        }

        for (const item of providerFixtures) {
          const home = item.teams.home;
          const away = item.teams.away;
          const { data: homeRow, error: homeError } = await supabase.from("football_teams")
            .upsert({ provider: PROVIDER, provider_team_id: String(home.id), name: home.name, logo_url: home.logo ?? null },
              { onConflict: "provider,provider_team_id" }).select("id").single();
          if (homeError) throw homeError;
          const { data: awayRow, error: awayError } = await supabase.from("football_teams")
            .upsert({ provider: PROVIDER, provider_team_id: String(away.id), name: away.name, logo_url: away.logo ?? null },
              { onConflict: "provider,provider_team_id" }).select("id").single();
          if (awayError) throw awayError;

          const fixtureId = String(item.fixture.id);
          const { data: fixtureRow, error: fixtureError } = await supabase.from("football_fixtures")
            .upsert({
              competition_id: dbCompetition.id,
              season_id: dbSeason.id,
              provider: PROVIDER,
              provider_fixture_id: fixtureId,
              round_name: item.league.round ?? null,
              kickoff_at: item.fixture.date,
              status: item.fixture.status.short,
              home_team_id: homeRow.id,
              away_team_id: awayRow.id,
              home_score: item.goals.home,
              away_score: item.goals.away,
              venue: item.fixture.venue?.name ?? null,
              referee: item.referee ?? null,
              synced_at: new Date().toISOString(),
              raw_payload: item,
            }, { onConflict: "provider,provider_fixture_id" }).select("id").single();
          if (fixtureError) throw fixtureError;
          fixturesUpserted++;

          const statsState = existingStats.get(fixtureId);
          const checkedTime = statsState?.checkedAt ? Date.parse(statsState.checkedAt) : 0;
          const needsFirstStatsFetch = !checkedTime;
          const needsOneConfirmationFetch = Boolean(checkedTime && !statsState?.confirmedAt &&
            (Date.now() - checkedTime) >= 24 * 60 * 60 * 1000);
          const kickoffTime = Date.parse(item.fixture.date);
          const isRecent = kickoffTime >= Date.now() - 7 * 24 * 60 * 60 * 1000;
          if (FINISHED_STATUSES.has(item.fixture.status.short) && isRecent &&
            (needsFirstStatsFetch || needsOneConfirmationFetch)) {
            if (requestsRemaining !== null && requestsRemaining <= 0) break;
            const statsResult = await providerGet<ProviderFixtureStats[]>("fixtures/statistics", { fixture: fixtureId });
            apiRequestsRemaining = statsResult.remaining;
            requestsRemaining = apiRequestsRemaining === null ? null : Number(apiRequestsRemaining);
            const statRows = (statsResult.body.response ?? []).flatMap((teamBlock) => {
              const teamId = teamBlock.team.id === home.id ? homeRow.id :
                teamBlock.team.id === away.id ? awayRow.id : null;
              return teamBlock.statistics.map((stat) => ({
                fixture_id: fixtureRow.id,
                team_id: teamId,
                provider: PROVIDER,
                stat_key: stat.type.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
                stat_label: stat.type,
                value_numeric: numberValue(stat.value),
                value_text: stat.value == null ? null : String(stat.value),
                raw_value: stat.value,
                synced_at: new Date().toISOString(),
              }));
            });
            if (statRows.length) {
              const { error } = await supabase.from("football_match_statistics")
                .upsert(statRows, { onConflict: "fixture_id,team_id,provider,stat_key" });
              if (error) throw error;
              statisticsUpserted += statRows.length;
            }
            const { error: checkedError } = await supabase.from("football_fixtures")
              .update({
                statistics_checked_at: new Date().toISOString(),
                statistics_confirmed_at: needsOneConfirmationFetch ? new Date().toISOString() : null,
                statistics_fetch_status: statRows.length ? "available" : "empty_response",
              }).eq("id", fixtureRow.id);
            if (checkedError) throw checkedError;
          }
        }

        outcomes.push({
          competition: competition.slug, status: "success",
          rounds: [...new Set(providerFixtures.map((item) => item.league.round).filter(Boolean))],
          fixturesSeen, fixturesUpserted, statisticsUpserted,
          apiRequestsRemaining,
        });
      } catch (error) {
        const message = String(error);
        if (message.includes("API_FOOTBALL_DAILY_QUOTA_REACHED")) {
          requestsRemaining = 0;
          outcomes.push({ competition: competition.slug, status: "deferred_quota" });
        } else {
          outcomes.push({ competition: competition.slug, status: "failed", error: message.slice(0, 350) });
        }
      }
    }

    const failed = outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "deferred_quota");
    const counts = outcomes.reduce((acc, outcome) => ({
      fixtures_seen: acc.fixtures_seen + Number(outcome.fixturesSeen ?? 0),
      fixtures_upserted: acc.fixtures_upserted + Number(outcome.fixturesUpserted ?? 0),
      statistics_upserted: acc.statistics_upserted + Number(outcome.statisticsUpserted ?? 0),
    }), { fixtures_seen: 0, fixtures_upserted: 0, statistics_upserted: 0 });
    const { error: finishError } = await supabase.from("football_sync_runs").update({
      ...counts,
      status: failed ? "partial" : "success",
      finished_at: new Date().toISOString(),
      details: { outcomes },
    }).eq("id", runId);
    if (finishError) return json({ error: "sync_finished_but_log_update_failed", detail: finishError.message, outcomes }, 500);
    return json({ season: `${seasonYear}/${String(seasonYear + 1).slice(-2)}`, outcomes });
  } catch (error) {
    await supabase.from("football_sync_runs").update({
      status: "failed", finished_at: new Date().toISOString(), error_summary: String(error).slice(0, 500),
    }).eq("id", runId);
    return json({ error: String(error).slice(0, 500) }, 500);
  }
});
