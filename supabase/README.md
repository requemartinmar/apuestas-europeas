# Cancha: sincronización de resultados

## Proveedor gratuito configurado

La Edge Function `sync-current-round` está preparada para `football-data.org` v4. El plan Free ofrece resultados con retraso, calendario y clasificación para LaLiga (`PD`), Premier League (`PL`), Bundesliga (`BL1`), Serie A (`SA`) y Champions League (`CL`). Europa League y Conference League no están incluidas en la cobertura gratuita. La página las identifica como no disponibles y la sincronización las deja inactivas para evitar mostrar jornadas antiguas como actuales.

El plan Free no incluye estadísticas detalladas (posesión, tiros, córneres o tarjetas) ni cuotas. Cancha no estima esos valores: deja las estadísticas vacías y muestra que el proveedor no las entregó. La disponibilidad y retraso de los marcadores dependen del proveedor.

Fuentes oficiales consultadas: [cobertura](https://www.football-data.org/coverage), [precios](https://www.football-data.org/pricing), [documentación v4](https://docs.football-data.org/general/v4/).

## Configuración

La función requiere estos secretos de servidor:

- `FOOTBALL_DATA_API_TOKEN`: token gratuito creado en [football-data.org](https://www.football-data.org/client/register).
- `SYNC_FUNCTION_SECRET`: secreto aleatorio compartido con la llamada de Cron en la cabecera `x-sync-secret`.
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`: los proporciona Supabase para la función; la clave de servicio nunca debe ponerse en el navegador.

La función determina automáticamente la temporada europea por año de inicio (en octubre de 2026 es `2026/27`) y permite fijarla mediante `FOOTBALL_SEASON`. Consulta los partidos entre 30 días antes y 15 días después de la fecha actual, hasta cinco llamadas por ejecución. La API v4 toma `dateTo` como límite exclusivo. Se recomienda sincronizar cada seis horas, sujeto al retraso propio del plan Free.

Para desplegar cuando exista el token gratuito:

```powershell
$supabaseSecure = Read-Host "Token personal de Supabase" -AsSecureString
$env:SUPABASE_ACCESS_TOKEN = [System.Net.NetworkCredential]::new("", $supabaseSecure).Password
$footballDataToken = Read-Host "Token de football-data.org"
.\node_modules\.bin\supabase.cmd secrets set "FOOTBALL_DATA_API_TOKEN=$footballDataToken" --project-ref ieqwkcznmbvewtavbpbn
.\node_modules\.bin\supabase.cmd functions deploy sync-current-round --project-ref ieqwkcznmbvewtavbpbn --use-api --no-verify-jwt
Remove-Item Env:SUPABASE_ACCESS_TOKEN
Remove-Variable supabaseSecure, footballDataToken
```

No escribas los tokens en el código ni los compartas en el chat. Después ejecuta una sincronización manual autenticada, comprueba que las cinco competiciones terminen con `SUCCESS` en `sincronizaciones` y solo entonces activa el Cron que ya está creado. El Cron del proyecto permanece pausado desde que la fuente anterior rechazó la temporada actual.

## Datos almacenados

- Resultados, fecha UTC, jornada/ronda, estado, nombres y escudos de los equipos.
- Fuente, hora de sincronización y payload original del proveedor para trazabilidad.
- Los identificadores de partido y equipo de football-data.org llevan un prefijo numérico interno para evitar colisiones con registros de la integración anterior.
- `estadisticas_estado = EMPTY_RESPONSE` en partidos finalizados indica que esta fuente gratuita no ofrece estadísticas; no significa que las cifras sean cero.
- Cada ejecución deja contadores y errores en `sincronizaciones`.

La función no obtiene ni importa temporadas completas: mantiene una ventana móvil para la jornada actual. Un proceso de backfill requerirá una tarea separada. El frontend solo lee Supabase y no contiene tokens del proveedor.
