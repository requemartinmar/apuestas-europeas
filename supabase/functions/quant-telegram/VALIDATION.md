# Validación de la candidata de modelos por competición

Fecha: 2026-11-08

## Base
- Edge Function de partida: `quant-telegram`, versión activa 63.
- SHA256 de origen informado por Supabase: `ccfaeac1073a936cd48c34b9ae2b99a136bc25e4cbb01ea8cde8b2809ec13676`.
- La candidata se guarda en esta rama y no está desplegada.

## Cambios incluidos
- Sustituye el modelo global compartido por una caché independiente por `sportKey`.
- Lee históricos con paginación explícita de 1.000 filas mediante `.range()`.
- LaLiga combina `quant_historical_matches` (competición LaLiga) con `historical_matches` (SP1), deduplicando por fecha + `teamKey(home)` + `teamKey(away)`. Si existe duplicado, prioriza `historical_matches`.
- Premier (E0), Serie A (I1) y Bundesliga (D1) usan sus históricos separados.
- Champions usa exclusivamente sus 753 partidos de `quant_historical_matches`.
- Europa League y Conference se omiten mientras no exista un histórico verificado para esas competiciones. No se reutilizan probabilidades de otra liga.
- `getTodayMatches`, combinadas y BOMBA REMATES solicitan el modelo de cada competición; no se reutiliza un único modelo para todas.

## Datos usados en la prueba
- `historical_matches`: 3.263 partidos de cuatro ligas.
- `quant_historical_matches`: 2.653 registros (1.900 LaLiga y 753 Champions).
- LaLiga tras fusionar y deduplicar: 2.008 partidos.
- Total de históricos domésticos para la prueba: 4.402 partidos.
- Evaluación walk-forward: 2.581 partidos entre 2025-01-01 y 2026-11-02, agrupando por fecha y prediciendo antes de incorporar los resultados de ese día.
- Normalización de equipos: `teamKey` de la Edge Function (incluye los mismos países, stop tokens y alias).

## Resultados
Comparación de un modelo global que mezcla las cuatro ligas domésticas frente a un modelo independiente por liga:

| Variante | N | Brier 1X2 ↓ | Log-loss ↓ | Acierto 1X2 |
|---|---:|---:|---:|---:|
| Global, cuatro ligas mezcladas | 2.581 | 0,596304 | 1,000174 | 52,00 % |
| Separado por competición | 2.581 | **0,595187** | **0,997851** | 51,88 % |

Resultados del modelo separado:
- E0 Premier: 662 partidos; Brier 0,609366; log-loss 1,015812; acierto 49,24 %.
- SP1 LaLiga: 688; Brier 0,580926; log-loss 0,978401; acierto 53,05 %.
- I1 Serie A: 681; Brier 0,587241; log-loss 0,986872; acierto 53,30 %.
- D1 Bundesliga: 550; Brier 0,605796; log-loss 1,014158; acierto 51,82 %.

Interpretación: separar competiciones mejora ligeramente Brier y log-loss, pero reduce el acierto bruto en 0,12 puntos porcentuales. Es una mejora pequeña, no una garantía de rentabilidad. Esta prueba compara dos variantes sobre el mismo conjunto doméstico; **no es todavía una comparación directa contra la versión activa**, cuyo modelo global actual carga LaLiga + Champions desde `quant_historical_matches`.

## Comprobaciones técnicas
- La candidata elimina las llamadas a `getModel()` y la firma antigua de `getTodayMatches(buttons, model)`.
- Se comprobó que existen paginación, caché por competición y exclusión explícita de competiciones sin histórico.
- El bloque TypeScript de carga de históricos y `getTodayMatches` pasó `tsc --noEmit --strict` con stubs de dependencias. No equivale a compilar toda la Edge Function: el entorno disponible no tiene Deno, así que queda pendiente el chequeo integral con Deno.
- No se ha ejecutado ningún despliegue ni se ha cambiado la función activa.

## Pendiente antes de desplegar
1. Ejecutar `deno check` sobre la Edge Function completa.
2. Hacer una comparación adicional contra la versión de producción con la misma ventana de evaluación y el mismo tratamiento temporal, incluyendo su histórico Champions/LaLiga.
3. Revisar muestras de equipos/alias con menos de cinco partidos y confirmar el comportamiento de las competiciones omitidas.
4. Aprobar expresamente el despliegue antes de sustituir `quant-telegram`.
