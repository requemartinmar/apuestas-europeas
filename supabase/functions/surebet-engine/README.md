# Surebet Engine (aislado)

Motor matemático independiente para detectar arbitraje entre cuotas. En esta
fase no se conecta a proveedores, Telegram, tablas Supabase ni a
`quant-telegram`.

## Módulos

- `types.ts`: contratos de entrada y salida.
- `match-markets.ts`: mejor cuota por resultado, solo dentro de una misma
  identidad canónica de evento/mercado/periodo/línea.
- `validate-opportunity.ts`: cobertura completa, consistencia, cuotas válidas y
  caducidad.
- `calculate-surebet.ts`: detección matemática.
- `calculate-stakes.ts`: reparto en céntimos y comprobación del peor retorno
  tras redondear.
- `calculate-surebet.test.ts`: pruebas deterministas.

## Matemática

Para cuotas decimales (o_i), existe arbitraje teórico cuando:

`sum(1 / o_i) < 1`

Para un presupuesto (T), el reparto ideal es:

`stake_i = T * (1 / o_i) / sum(1 / o_j)`

El reparto real se redondea a céntimos y se vuelve a comprobar el peor retorno.
Si el peor retorno no supera el presupuesto, no se devuelve una asignación
rentable.

## Ejecutar pruebas

Desde la raíz del repositorio:

```powershell
deno test .\supabase\functions\surebet-engine\calculate-surebet.test.ts
deno check .\supabase\functions\surebet-engine\calculate-surebet.test.ts
```

## Límites deliberados de esta fase

- No consulta ni ejecuta apuestas en casas.
- No aplica comisiones de exchange, límites, impuestos, anulaciones ni reglas
  particulares.
- No hace matching difuso de nombres. `eventId` debe venir de una
  fuente/crosswalk fiable.
- No usa cachés de probabilidades o estadísticas como fuente de cuotas.
- `VALIDATED` solo significa que la estructura y frescura de los datos pasan las
  comprobaciones locales; no significa que una casa haya aceptado una apuesta ni
  garantiza beneficio ejecutable.
- No se ha integrado ni desplegado en Supabase.

Antes de conectar proveedores habrá que añadir adaptadores, tratamiento de
comisiones/límites y una verificación de cuotas inmediatamente anterior a
cualquier posible ejecución.
