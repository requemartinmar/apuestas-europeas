create or replace function public.sync_historical_match_stats_to_partidos()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_competition_id text;
begin
  v_competition_id := case new.league_code
    when 'SP1' then '140'
    when 'E0' then '39'
    when 'D1' then '78'
    when 'I1' then '135'
    when 'F1' then '61'
    else null
  end;

  if v_competition_id is null then return new; end if;
  if new.home_shots is null and new.away_shots is null
     and new.home_shots_on_target is null and new.away_shots_on_target is null
     and new.home_corners is null and new.away_corners is null
     and new.home_yellow is null and new.away_yellow is null
     and new.home_red is null and new.away_red is null then
    return new;
  end if;

  insert into public.estadisticas_partido (
    partido_id, tiros_totales_local, tiros_totales_visitante,
    tiros_puerta_local, tiros_puerta_visitante,
    corners_local, corners_visitante,
    tarjetas_amarillas_local, tarjetas_amarillas_visitante,
    tarjetas_rojas_local, tarjetas_rojas_visitante,
    fuente, capturado_at, raw_payload
  )
  select
    p.id, new.home_shots, new.away_shots,
    new.home_shots_on_target, new.away_shots_on_target,
    new.home_corners, new.away_corners,
    new.home_yellow, new.away_yellow, new.home_red, new.away_red,
    'football-data.co.uk', now(),
    jsonb_build_object(
      'historical_id', new.id, 'league_code', new.league_code,
      'season', new.season, 'match_date', new.match_date,
      'home_team', new.home_team, 'away_team', new.away_team
    )
  from public.partidos p
  join public.equipo_alias home_alias
    on home_alias.equipo_id = p.equipo_local_id
   and home_alias.hist_league = new.league_code
   and lower(home_alias.hist_team) = lower(new.home_team)
  join public.equipo_alias away_alias
    on away_alias.equipo_id = p.equipo_visitante_id
   and away_alias.hist_league = new.league_code
   and lower(away_alias.hist_team) = lower(new.away_team)
  where p.competid_id = v_competition_id
    and p.fecha_utc::date = new.match_date
    and p.estado = 'FINISHED'
  on conflict (partido_id) do update set
    tiros_totales_local = excluded.tiros_totales_local,
    tiros_totales_visitante = excluded.tiros_totales_visitante,
    tiros_puerta_local = excluded.tiros_puerta_local,
    tiros_puerta_visitante = excluded.tiros_puerta_visitante,
    corners_local = excluded.corners_local,
    corners_visitante = excluded.corners_visitante,
    tarjetas_amarillas_local = excluded.tarjetas_amarillas_local,
    tarjetas_amarillas_visitante = excluded.tarjetas_amarillas_visitante,
    tarjetas_rojas_local = excluded.tarjetas_rojas_local,
    tarjetas_rojas_visitante = excluded.tarjetas_rojas_visitante,
    capturado_at = excluded.capturado_at,
    raw_payload = excluded.raw_payload
  where public.estadisticas_partido.fuente = 'football-data.co.uk';

  update public.partidos p
  set estadisticas_estado = 'AVAILABLE',
      estadisticas_primera_captura_at = coalesce(p.estadisticas_primera_captura_at, now()),
      estadisticas_confirmada_at = now()
  where p.competid_id = v_competition_id
    and p.fecha_utc::date = new.match_date
    and p.estado = 'FINISHED'
    and exists (
      select 1 from public.equipo_alias home_alias
      join public.equipo_alias away_alias
        on away_alias.hist_league = new.league_code
       and lower(away_alias.hist_team) = lower(new.away_team)
      join public.estadisticas_partido s on s.partido_id = p.id
      where home_alias.equipo_id = p.equipo_local_id
        and home_alias.hist_league = new.league_code
        and lower(home_alias.hist_team) = lower(new.home_team)
        and away_alias.equipo_id = p.equipo_visitante_id
    );
  return new;
end;
$$;

drop trigger if exists historical_match_stats_to_partidos on public.historical_matches;
create trigger historical_match_stats_to_partidos
after insert or update of
  home_shots, away_shots, home_shots_on_target, away_shots_on_target,
  home_corners, away_corners, home_yellow, away_yellow, home_red, away_red
on public.historical_matches
for each row execute function public.sync_historical_match_stats_to_partidos();
