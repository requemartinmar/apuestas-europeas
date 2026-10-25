# Ingesta de datos en Supabase

Base de trabajo para que el panel consuma datos actuales y verificables desde Supabase. Esta aplicación tiene su propio despliegue, base de datos y secretos.

## Alojamiento gratuito, sin PC encendido

- **Web**: Cloudflare Pages publica el frontend estático desde GitHub/GitLab. El plan Free permite hasta 500 builds al mes; Workers/Pages también sirve la web en la nube. Cloudflare documenta el alta gratuita sin tarjeta.
- **Base de datos y autenticación**: Supabase Free aloja Postgres, Auth y Edge Functions. El plan publicado incluye 500 MB de base de datos, 5 GB de salida, 500.000 invocaciones de funciones y cuesta $0 mientras se respeten las cuotas. La página oficial confirma el precio gratuito, pero no aclara expresamente si la creación de cuenta/proyecto exige tarjeta; comprobarlo en el alta antes de elegirlo como requisito definitivo.
- **Sincronización automática**: Supabase Cron invoca la Edge Function en sus servidores. API-Football publica un plan gratuito de 100 peticiones al día sin tarjeta. El PC solo se necesita para desarrollar y desplegar cambios; la web y las sincronizaciones ya publicadas siguen alojadas.
- **Pausa por inactividad**: con la sincronización diaria de partidos y jornadas hay actividad recurrente en la base de datos. Supabase indica que sus proyectos gratuitos se pausan cuando tienen poca actividad durante siete días; una escritura programada por jornada debería evitarlo. También vigilaremos el panel y los avisos del proyecto.

Cloudflare Pages es la opción inicial para la web, y Supabase sigue siendo la única base de datos central. No se añade un segundo proveedor de base de datos.

## Fuentes

- **API-Football / API-Sports**: fixtures, jornada, marcador final y estadísticas por equipo y partido. La cobertura estadística cambia según liga y temporada; hay que revisar la cobertura de 2026/27 antes de mostrar cada campo.
- **The Odds API**: cuotas y mercados. Es una fuente separada de los resultados y estadísticas. La clave que ya usa `bot_v3.py` no debe llegar al navegador.
- **AS, Marca y Mundo Deportivo**: referencias editoriales para contraste y enlaces. No se implementa scraping automático: AS condiciona la reproducción/transformación de sus contenidos a autorización. Para extraer y reutilizar datos de una web editorial habría que revisar sus condiciones y obtener permiso cuando proceda.

## Flujo

1. Supabase Cron llama a `functions/sync-current-round`.
2. La función determina el año inicial de la temporada europea (por ejemplo, octubre de 2026 corresponde a `2026/27`). Se puede fijar con `FOOTBALL_SEASON`.
3. Por cada competición hace una petición de fixtures de temporada y guarda jornadas en una ventana móvil de siete días pasados y siete futuros. Incluye LaLiga, Premier League, Bundesliga, Serie A y las jornadas de Champions League, Europa League y Conference League. Las jornadas anteriores permanecen en la base.
4. Cuando un partido termina, guarda estadísticas por equipo. Hace una segunda consulta pasadas 24 horas para detectar correcciones tardías y luego las deja confirmadas. Los valores ausentes permanecen nulos; nunca se rellenan con estimaciones.
5. Cada ejecución deja estado, contadores y errores en `football_sync_runs`. Cada fixture conserva proveedor, ID externo, respuesta original y hora de sincronización.
6. El panel consultará las tablas de Supabase y mostrará la jornada, el marcador, los datos disponibles y la hora/fuente de actualización.

La función usa las competiciones API-Football: LaLiga `140`, Premier League `39`, Bundesliga `78`, Serie A `135`, Champions League `2`, Europa League `3` y Conference League `848`. API-Football usa formatos de ronda como fase liga y eliminatorias, guardados literalmente en `round_name`. Los nombres/IDs de proveedor se guardan en `football_competitions`, no se exponen como secretos.

## Preparación en un proyecto Supabase dedicado

1. Revisar y ejecutar `schema.sql` en el proyecto Supabase de esta app.
2. Configurar los Function Secrets `APISPORTS_FOOTBALL_KEY` y `SYNC_FUNCTION_SECRET`. `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` deben estar disponibles en la función como secretos de servidor.
3. Desplegar la función `sync-current-round` y configurar Supabase Cron. El ritmo inicial es cada seis horas (`0 */6 * * *`): son 28 llamadas de fixtures al día para las siete competiciones, más las estadísticas pendientes de partidos terminados. API-Football publica un plan gratuito de 100 peticiones al día; se guarda la cuota restante y hay que reducir la frecuencia si el consumo real se acerca al límite.
4. La llamada programada debe incluir `x-sync-secret` desde Supabase Vault. La función valida ese secreto porque `verify_jwt` está desactivado para permitir la invocación desde Cron.
5. Conectar la vista de jornadas a Supabase con autenticación de usuario. La clave `service_role` solo se usa dentro de la función.

## Límites conocidos

- La cuota de API-Sports depende del plan. Con siete competiciones, la función hace siete peticiones de fixtures por ejecución y hasta dos de estadísticas por partido terminado reciente (la primera captura y una confirmación pasadas 24 horas). El ritmo de seis horas deja 28 llamadas fijas al día y margen para resultados y estadísticas dentro de la cuota gratuita habitual.
- El proveedor anuncia 100 solicitudes/día en el plan Free, sin tarjeta, pero indica que la disponibilidad de estadísticas puede variar por liga y temporada. Antes de dar por fiable un campo de la jornada 2026/27 hay que verificar la cobertura real devuelta para cada competición.
- Cada liga puede ofrecer campos distintos. Un valor nulo significa que el proveedor no entregó ese campo; el panel debe distinguirlo de un cero real.
- `statistics_fetch_status` distingue entre pendiente, estadísticas recibidas y respuesta vacía del proveedor; una respuesta vacía no se presenta como un cero.
- Este flujo prioriza la jornada vigente y los partidos cercanos. Para importar temporadas completas se añadirá un backfill separado, con límites de llamadas y control de duplicados.
- La ingesta de cuotas de The Odds API debe añadirse como sincronizador separado con snapshots por casa, mercado y hora; no se mezcla con el estado de resultados.
