alter table public.partidos add column if not exists api_fixture_id bigint;
create unique index if not exists partidos_api_fixture_id_uidx
  on public.partidos(api_fixture_id) where api_fixture_id is not null;