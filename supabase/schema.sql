-- Esquema inicial para la app personal de análisis de fútbol.
-- Ejecutar en un proyecto Supabase NUEVO o después de revisar el esquema destino.
-- Los IDs del proveedor se conservan para poder auditar y re-sincronizar.

create extension if not exists pgcrypto;

create table if not exists public.football_competitions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  country text not null,
  provider text not null,
  provider_competition_id text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (provider, provider_competition_id)
);

create table if not exists public.football_seasons (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.football_competitions(id) on delete cascade,
  season_start_year integer not null,
  label text not null,
  is_current boolean not null default false,
  provider_season_id text not null,
  created_at timestamptz not null default now(),
  unique (competition_id, season_start_year),
  unique (competition_id, provider_season_id)
);

create unique index if not exists football_one_current_season_per_competition
  on public.football_seasons (competition_id) where is_current;

create table if not exists public.football_teams (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_team_id text not null,
  name text not null,
  short_name text,
  logo_url text,
  created_at timestamptz not null default now(),
  unique (provider, provider_team_id)
);

create table if not exists public.football_fixtures (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.football_competitions(id),
  season_id uuid not null references public.football_seasons(id),
  provider text not null,
  provider_fixture_id text not null,
  round_name text,
  kickoff_at timestamptz not null,
  status text not null,
  home_team_id uuid not null references public.football_teams(id),
  away_team_id uuid not null references public.football_teams(id),
  home_score integer,
  away_score integer,
  statistics_checked_at timestamptz,
  statistics_confirmed_at timestamptz,
  statistics_fetch_status text not null default 'pending'
    check (statistics_fetch_status in ('pending','available','empty_response')),
  venue text,
  referee text,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb,
  unique (provider, provider_fixture_id),
  check (home_team_id <> away_team_id)
);

create index if not exists football_fixtures_round_idx
  on public.football_fixtures (competition_id, season_id, round_name, kickoff_at);
create index if not exists football_fixtures_status_date_idx
  on public.football_fixtures (status, kickoff_at desc);

create table if not exists public.football_match_statistics (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.football_fixtures(id) on delete cascade,
  team_id uuid references public.football_teams(id),
  provider text not null,
  stat_key text not null,
  stat_label text not null,
  value_numeric numeric,
  value_text text,
  raw_value jsonb,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (fixture_id, team_id, provider, stat_key)
);

create index if not exists football_stats_fixture_idx
  on public.football_match_statistics (fixture_id, stat_key);

create table if not exists public.football_odds_snapshots (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.football_fixtures(id) on delete cascade,
  provider text not null,
  bookmaker text not null,
  market_key text not null,
  selection_key text not null,
  line numeric,
  price numeric not null check (price > 1),
  captured_at timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb
);

create index if not exists football_odds_fixture_market_idx
  on public.football_odds_snapshots (fixture_id, market_key, captured_at desc);

create table if not exists public.football_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  competition_slug text,
  season_start_year integer,
  sync_kind text not null,
  status text not null check (status in ('running','success','partial','failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fixtures_seen integer not null default 0,
  fixtures_upserted integer not null default 0,
  statistics_upserted integer not null default 0,
  error_summary text,
  details jsonb not null default '{}'::jsonb
);

-- App privada: usuarios autenticados pueden consultar los datos deportivos.
-- Las escrituras se hacen solo desde Edge Functions usando la service role key.
do $$
declare t text;
begin
  foreach t in array array[
    'football_competitions','football_seasons','football_teams','football_fixtures',
    'football_match_statistics','football_odds_snapshots','football_sync_runs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)',
      t || '_authenticated_read', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Configuración API-Sports / API-Football. La función crea la temporada vigente.
insert into public.football_competitions (slug, name, country, provider, provider_competition_id)
values
  ('laliga', 'LaLiga', 'España', 'api-football', '140'),
  ('premier-league', 'Premier League', 'Inglaterra', 'api-football', '39'),
  ('bundesliga', 'Bundesliga', 'Alemania', 'api-football', '78'),
  ('serie-a', 'Serie A', 'Italia', 'api-football', '135'),
  ('champions-league', 'UEFA Champions League', 'Europa', 'api-football', '2'),
  ('europa-league', 'UEFA Europa League', 'Europa', 'api-football', '3'),
  ('conference-league', 'UEFA Conference League', 'Europa', 'api-football', '848')
on conflict (slug) do update set
  name = excluded.name,
  country = excluded.country,
  provider = excluded.provider,
  provider_competition_id = excluded.provider_competition_id;
