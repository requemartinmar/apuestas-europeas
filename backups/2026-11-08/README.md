# Backup completo — Bot Quant

Fecha: 2026-11-08

## Código
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

## Base de datos
Se creó una copia de datos de todas las tablas existentes del esquema `public`, con prefijo `backup_20261108_`. Son tablas independientes creadas como copia de columnas y filas (CTAS).

Recuentos contrastados:
| Tabla original | Filas originales | Filas en copia |
|---|---:|---:|
| historical_matches | 3.263 | 3.263 |
| quant_historical_matches | 2.653 | 2.653 |
| equipo_alias | 78 | 78 |

Las copias CTAS conservan los datos y columnas, pero no replican índices, claves, políticas RLS, triggers ni secuencias. No se copiaron secretos ni valores de variables de entorno.

## Seguridad del cambio
La Edge Function activa no se ha modificado ni desplegado. No se han actualizado ni eliminado filas de las tablas originales. Las copias están en el mismo proyecto Supabase, no son un backup externo del proveedor.
