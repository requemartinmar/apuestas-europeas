# Backup completo — Bot Quant

Fecha: 2026-11-08

## Código

Se recuperaron y guardaron las cuatro Edge Functions activas del proyecto:
| Función | Versión | verify_jwt | SHA256 de producción |
|---|---:|---:|---|
| `quant-telegram` | 63 | false | `ccfaeac1073a936cd48c34b9ae2b99a136bc25e4cbb01ea8cde8b2809ec13676` |
| `sync-current-round` | 21 | false | `69c301c8017ff5183000d995d4594b5227e38c01a02909d67e943471c0acdba3` |
| `import-historical` | 7 | true | `515c96400f897ba18b01f5a625043a48c5411f456656e22cc643de2219beccc3` |
| `sync-player-match-stats` | 3 | false | `8b9a7fbc6988159d5a0320d76a4520294490f215108c6e29d54cc417fc14ea33` |

Los archivos de las funciones están bajo `backups/2026-11-08/functions/` (y la función Quant principal también en `quant-telegram-production-index.ts`).

- Repositorio: `requemartinmar/apuestas-europeas`
- Rama base copiada: `main`
- Commit base: `890d3686ca9e0217503b450faf58c49b7bdf4a86`
- Rama de respaldo: `backup/quant-telegram-production-2026-11-08`
- Edge Function: `quant-telegram`
- Versión activa capturada: `63`
- Estado: `ACTIVE`
- verify_jwt: `false`
- SHA256 informado por Supabase: `ccfaeac1073a936cd48c34b9ae2b99a136bc25e4cbb01ea8cde8b2809ec13676`
- Código de producción guardado en `quant-telegram-production-index.ts` (55.982 caracteres).

## Migraciones registradas en Supabase

`202610300001 quant_model`; `20261031083830 matches_multi_source_sync`; `20261107113633 expand_oddster_partidos_metrics`; `20261108092529 equipo_alias_y_partidos_del_dia`; `20261108092825 historical_import_log`; `20261108113952 add_footystats_competition_and_team_snapshots`; `20261108114835 add_verified_player_match_stats`; `20261108120242 create_player_match_shot_history`; `20261108120322 remove_redundant_player_shot_table`; `20261108120336 add_player_shot_empirical_windows_view`.

## Base de datos
Se creó una copia de datos de todas las tablas existentes del esquema `public`, con prefijo `backup_20261108_`. Son tablas independientes creadas como copia de columnas y filas (CTAS).

Se compararon los recuentos de las 24 tablas originales y sus copias: **24/24 coinciden exactamente**. Recuentos principales:
| Tabla original | Filas originales | Filas en copia |
|---|---:|---:|
| historical_matches | 3.263 | 3.263 |
| quant_historical_matches | 2.653 | 2.653 |
| equipo_alias | 78 | 78 |

Las copias CTAS conservan los datos y columnas, pero no replican índices, claves, triggers ni secuencias. Se habilitó RLS en las 24 copias y se revocó SELECT a `anon` y `authenticated` (verificado: 24/24 con RLS y cero permisos SELECT para esos roles). No se copiaron secretos ni valores de variables de entorno.

## Seguridad del cambio
La Edge Function activa no se ha modificado ni desplegado. No se han actualizado ni eliminado filas de las tablas originales. Las copias están en el mismo proyecto Supabase, no son un backup externo del proveedor.
