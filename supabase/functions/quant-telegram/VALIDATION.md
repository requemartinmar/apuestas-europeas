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
**Comparación principal: arquitectura activa frente a candidata.** La referencia reproduce el diseño actual: un solo modelo cargado desde los 2.653 registros de `quant_historical_matches` (LaLiga + Champions) y reutilizado para los 2.581 partidos domésticos de evaluación. La candidata usa los históricos domésticos de cada competición y LaLiga fusionada.

| Variante | Histórico de entrenamiento | N evaluado | Brier 1X2 ↓ | Log-loss ↓ | Acierto 1X2 |
|---|---|---:|---:|---:|---:|
| Arquitectura actual (un modelo Quant compartido) | 2.653 LaLiga + Champions | 2.581 | 0,627079 | 1,042243 | 46,18 % |
| **Candidata (modelo por liga)** | **4.402 domésticos, sin mezclar competiciones** | **2.581** | **0,595187** | **0,997851** | **51,88 %** |

La candidata reduce el Brier en 0,031892 y el log-loss en 0,044391, y mejora el acierto en 5,70 puntos porcentuales en esta evaluación. La mejora procede principalmente de que deja de aplicar el mismo modelo LaLiga/Champions a Premier, Serie A y Bundesliga, y añade sus históricos reales.

Como control adicional, al comparar un modelo global que mezcla las cuatro ligas domésticas con modelos separados, los resultados fueron Brier 0,596304 / log-loss 1,000174 / acierto 52,00 % para el global, frente a Brier 0,595187 / log-loss 0,997851 / acierto 51,88 % para los separados. Esa diferencia entre ambos enfoques es pequeña; la mejora principal es frente al diseño activo que carece de históricos domésticos para tres ligas.

Resultados del modelo separado:
- E0 Premier: 662 partidos; Brier 0,609366; log-loss 1,015812; acierto 49,24 %.
- SP1 LaLiga: 688; Brier 0,580926; log-loss 0,978401; acierto 53,05 %.
- I1 Serie A: 681; Brier 0,587241; log-loss 0,986872; acierto 53,30 %.
- D1 Bundesliga: 550; Brier 0,605796; log-loss 1,014158; acierto 51,82 %.

Interpretación: separar competiciones mejora ligeramente Brier y log-loss, pero reduce el acierto bruto en 0,12 puntos porcentuales. Es una mejora pequeña, no una garantía de rentabilidad. La comparación principal anterior sí incluye una reproducción aproximada del diseño de producción actual; no es una prueba end-to-end del webhook ni de todos sus mercados.

## Comprobaciones técnicas
- La candidata elimina las llamadas a `getModel()` y la firma antigua de `getTodayMatches(buttons, model)`.
- Se comprobó que existen paginación, caché por competición y exclusión explícita de competiciones sin histórico.
- La Edge Function completa pasó `deno check supabase/functions/quant-telegram/index.ts` con Deno 2.9.8 en Windows, tras corregir cuatro errores de TypeScript. Este chequeo valida tipos/imports, pero no ejecuta el webhook ni sustituye las pruebas funcionales.
- No se ha ejecutado ningún despliegue ni se ha cambiado la función activa.

## QA adicional y salvaguardas
- Los partidos solo se devuelven con probabilidades si ambos equipos se reconocen y cada uno alcanza el mínimo de cinco partidos históricos; los encuentros sin muestra suficiente o con alias no resuelto se omiten y se informan, en vez de calcular con equipos neutrales.
- El fallback de fixtures de OpenFootball queda limitado a la competición doméstica exacta. No reutiliza partidos de LaLiga/Premier/Serie A/Bundesliga etiquetándolos como Champions. Champions depende de sus fuentes propias; Europa League y Conference siguen omitidas al no existir histórico verificado.

## Pendiente antes de desplegar
1. Ejecutar pruebas funcionales controladas de las rutas de partidos, combinadas, BOMBA REMATES y errores de fuentes; `deno check` no las ejecuta.
2. Revisar con datos reales la cobertura de alias y qué equipos/partidos quedan omitidos por no alcanzar cinco partidos.
3. Confirmar la disponibilidad y frescura de históricos de remates, cuotas y partidos de cada competición.
4. Aprobar expresamente el despliegue antes de sustituir `quant-telegram`.

## Registro de predicciones (implementación candidata)

- Añadido `logModelPredictions()` en `index.ts`: registra cinco probabilidades por partido válido que devuelve `getTodayMatches`: local/empate/visitante, más de 2,5 goles y ambos marcan.
- Cada fila incluye competición, `sport_key`, evento si lo proporciona The Odds API, equipos, inicio, versión del modelo, probabilidades y lambdas esperadas.
- Captura anterior al inicio del partido; solo se procesan encuentros futuros devueltos por el proveedor.
- Idempotencia por evento/competición/equipos/fecha + mercado/selección. Las solicitudes repetidas no duplican filas.
- El registro se ejecuta antes de que las funciones que consumen `getTodayMatches` construyan sus respuestas. Si falla la escritura, el bot sigue respondiendo y deja un error explícito en logs y en la lista de incidencias.
- La tabla `public.quant_prediction_log` existe en Supabase. Se verificó su esquema, RLS/privilegios en la revisión previa y se añadió un índice único no parcial para que el `upsert` por `idempotency_key` sea compatible con PostgreSQL.
- **Alcance aún no completado:** esta versión registra los mercados principales del partido. No registra todavía las selecciones de BOMBA REMATES, combinadas ni mercados individuales de jugadores.
- **Liquidación automática añadida a la candidata:** `settleModelPredictions()` consulta predicciones pendientes con inicio hace más de dos horas y las contrasta con `public.partidos`, sincronizada desde football-data.org, junto con los nombres de `public.equipos`.
- Solo liquida partidos con estado exacto `FINISHED`, goles no nulos, competición coincidente (LaLiga 140, Premier 39, Serie A 135, Bundesliga 78 o Champions 2), local/visitante reconocidos por `teamKey` y hora de inicio a menos de 12 horas de diferencia.
- Calcula los resultados de 1X2, over de la línea registrada (2,5 en esta captura) y BTTS sí. Guarda `won/lost`, marcador, fecha, fuente y payload de verificación.
- Si no encuentra coincidencia o encuentra varias, deja el pronóstico pendiente y contabiliza `unmatched/ambiguous`; no fuerza una liquidación. Europa League y Conference no se liquidan con esta fuente porque no están incluidas en la sincronización actual.
- La liquidación se ejecuta al consultar partidos y desde la ruta CRON de la candidata. En la base se comprobó que existe un cron cada seis horas para `sync-current-round`, pero **no existe todavía un cron programado para `quant-telegram`**. Para liquidación desatendida habrá que añadirlo después del despliegue autorizado, usando el secreto almacenado en Vault; no se ha creado ni modificado ningún cron.
- Estado actual de los datos al revisar Supabase: `quant_prediction_log` tiene 0 filas; `partidos` tiene 299 encuentros (241 `FINISHED`, 56 `SCHEDULED`, 1 `LIVE`, 1 `NOT_PLAYED`). Por tanto, aún no hay predicciones nuevas que liquidar.
- **No desplegado.** El código de liquidación aún debe pasar `deno check` y pruebas funcionales controladas de escritura, idempotencia y emparejamiento antes de cualquier despliegue.
