# Surebet Engine (aislado)

Motor matemático independiente para detectar arbitraje entre cuotas. No se conecta
a proveedores, Telegram, tablas Supabase ni a `quant-telegram`.

## Flujo recomendado

Usar `evaluateSurebet()` como punto de entrada único:

1. Obtiene de las reglas internas los resultados obligatorios del mercado.
2. Selecciona la mejor cuota de cada resultado sin mezclar evento, mercado, periodo o línea.
3. Valida frescura, identidad y entradas.
4. Calcula el arbitraje.
5. Reparte el presupuesto en céntimos y comprueba el peor retorno redondeado.

No se debe usar una lista de resultados suministrada por el consumidor como autoridad
para declarar completo un mercado. `calculateSurebet()` y `calculateStakes()`
son primitivas matemáticas; por sí solas no prueban cobertura de mercado.

## Mercados con cobertura definida

- `1x2`: `home`, `draw`, `away`; línea `null`.
- `totals`: `over`, `under`; línea numérica obligatoria.
- `btts`: `yes`, `no`; línea `null`.

Cualquier otro mercado se rechaza hasta que se añada explícitamente su definición
y sus pruebas. No se adivinan resultados para mercados desconocidos.

## Matemática

Para cuotas decimales (o_i), existe arbitraje teórico cuando:

`sum(1 / o_i) < 1`

Para un presupuesto (T), el reparto ideal es:

`stake_i = T * (1 / o_i) / sum(1 / o_j)`

El reparto real se redondea a céntimos mediante mayores restos y se vuelve a
comprobar el peor retorno después de redondear. Si no supera el presupuesto,
no se devuelve una asignación rentable.

## Ejecutar pruebas

Desde la raíz del repositorio:

```powershell
deno test .\supabase\functions\surebet-engine\calculate-surebet.test.ts
deno check .\supabase\functions\surebet-engine\mod.ts
```

## Límites

- No consulta ni ejecuta apuestas en casas.
- No aplica comisiones de exchange, límites, impuestos, anulaciones ni reglas particulares.
- No hace matching difuso de nombres. `eventId` debe proceder de una fuente/crosswalk fiable.
- `VALIDATED` solo acredita estructura y frescura local; no significa que una casa acepte la apuesta ni garantiza beneficio ejecutable.
- Antes de conectar proveedores hacen falta adaptadores, reglas de liquidación y una verificación de cuotas inmediatamente anterior a cualquier posible ejecución.
