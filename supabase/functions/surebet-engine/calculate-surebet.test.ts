import {
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateSurebet } from "./calculate-surebet.ts";
import { calculateStakes } from "./calculate-stakes.ts";
import { selectBestCompleteMarketOffers } from "./match-markets.ts";
import { validateOpportunity } from "./validate-opportunity.ts";
import { evaluateSurebet } from "./evaluate-surebet.ts";
import type { OddsOffer } from "./types.ts";

const NOW = 1_800_000_000_000;
const offer = (
  selectionKey: string,
  odds: number,
  overrides: Partial<OddsOffer> = {},
): OddsOffer => ({
  eventId: "fixture-123",
  eventName: "Team A - Team B",
  marketKey: "1x2",
  period: "FT",
  line: null,
  selectionKey,
  bookmaker: `book-${selectionKey}`,
  odds,
  capturedAtMs: NOW - 1_000,
  ...overrides,
});
const total = (
  selectionKey: string,
  odds: number,
  overrides: Partial<OddsOffer> = {},
) => offer(selectionKey, odds, {
  marketKey: "totals",
  line: 2.5,
  ...overrides,
});

Deno.test("calcula arbitraje matemático de dos resultados", () => {
  const result = calculateSurebet(
    [total("over", 2.1), total("under", 2.05)],
    100,
  );
  if (!result) throw new Error("Se esperaba oportunidad");
  assertAlmostEquals(result.inverseOddsSum, 0.96399535, 0.0000001);
  assertAlmostEquals(result.theoreticalProfitPercent, 3.73494, 0.001);
});

Deno.test("calcula arbitraje 1X2 con tres resultados", () => {
  const result = calculateSurebet([
    offer("home", 2.6),
    offer("draw", 3.7),
    offer("away", 3.1),
  ], 100);
  if (!result) throw new Error("Se esperaba oportunidad 1X2");
  assertAlmostEquals(result.inverseOddsSum, 0.97747, 0.00002);
});

Deno.test("rechaza mercado sin arbitraje, cuotas inválidas y beneficio infinito", () => {
  assertEquals(calculateSurebet([total("over", 1.9), total("under", 1.9)], 100), null);
  assertEquals(calculateSurebet([total("over", 2), total("under", 1)], 100), null);
  assertEquals(calculateSurebet([total("over", 2), total("over", 3)], 100), null);
  assertEquals(calculateSurebet([
    total("over", Number.MAX_VALUE),
    total("under", Number.MAX_VALUE),
  ], 100), null);
});

Deno.test("reparte stake en céntimos y conserva el presupuesto", () => {
  const allocations = calculateStakes(
    [total("over", 2.1), total("under", 2.05)],
    100,
  );
  if (!allocations) throw new Error("Se esperaba reparto");
  assertEquals(
    allocations.reduce((sum, item) => sum + Math.round(item.stake * 100), 0),
    10_000,
  );
  assertAlmostEquals(allocations[0].stake, 49.4, 0.02);
  assertAlmostEquals(allocations[1].stake, 50.6, 0.02);
  assertEquals(allocations.every((item) => item.payout > 100), true);
});

Deno.test("rechaza si el redondeo o el presupuesto no garantiza beneficio", () => {
  assertEquals(calculateStakes([total("over", 2), total("under", 2)], 100), null);
  assertEquals(calculateStakes([total("over", 2.1), total("under", 2.05)], 0.01), null);
});

Deno.test("rechaza importes con fracciones de céntimo o fuera del rango seguro", () => {
  assertEquals(calculateStakes([total("over", 2.1), total("under", 2.05)], 10.001), null);
  assertEquals(calculateStakes(
    [total("over", 2.1), total("under", 2.05)],
    Number.MAX_SAFE_INTEGER,
  ), null);
});

Deno.test("rechaza cuotas y casas inválidas en el reparto", () => {
  assertEquals(calculateStakes([
    total("over", 2.1),
    total("under", 2.05, { bookmaker: "   " }),
  ], 100), null);
});

Deno.test("selecciona la mejor cuota por resultado sin mezclar eventos", () => {
  const selected = selectBestCompleteMarketOffers([
    offer("home", 2.0),
    offer("home", 2.2, { bookmaker: "book-b" }),
    offer("away", 2.1),
    offer("draw", 3.5),
    offer("away", 99, { eventId: "otro-evento" }),
  ], ["home", "draw", "away"]);
  if (!selected) throw new Error("Se esperaba mercado completo");
  assertEquals(selected.find((item) => item.selectionKey === "home")?.odds, 2.2);
  assertEquals(selected.length, 3);
});

Deno.test("no completa un 1X2 si falta empate aunque el llamante lo omita", () => {
  const incomplete = [offer("home", 2.2), offer("away", 2.1)];
  assertEquals(
    selectBestCompleteMarketOffers(incomplete, ["home", "away"]),
    null,
  );
  assertEquals(
    validateOpportunity(incomplete, ["home", "away"], {
      nowMs: NOW,
      maxAgeMs: 30_000,
    }).status,
    "REJECTED",
  );
});

Deno.test("no completa totales si falta over o under", () => {
  assertEquals(
    validateOpportunity([total("over", 2.1)], ["over", "under"], {
      nowMs: NOW,
      maxAgeMs: 30_000,
    }).status,
    "REJECTED",
  );
});

Deno.test("valida mercado 1X2 completo y reciente", () => {
  const result = validateOpportunity(
    [offer("home", 2.1), offer("draw", 3.5), offer("away", 3.8)],
    ["home", "draw", "away"],
    { nowMs: NOW, maxAgeMs: 30_000 },
  );
  assertEquals(result.status, "VALIDATED");
});

Deno.test("rechaza mezcla de periodo y caduca cuotas antiguas en totales", () => {
  const mixed = validateOpportunity([
    total("over", 2.1),
    total("under", 2.2, { period: "1H" }),
  ], ["over", "under"], { nowMs: NOW, maxAgeMs: 30_000 });
  assertEquals(mixed.status, "REJECTED");

  const expired = validateOpportunity([
    total("over", 2.1, { capturedAtMs: NOW - 60_000 }),
    total("under", 2.2),
  ], ["over", "under"], { nowMs: NOW, maxAgeMs: 30_000 });
  assertEquals(expired.status, "EXPIRED");
  assertNotEquals(expired.reason, undefined);
});

Deno.test("rechaza maxFutureSkewMs negativo, NaN e infinito", () => {
  for (const maxFutureSkewMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateOpportunity([
      total("over", 2.1), total("under", 2.2),
    ], ["over", "under"], {
      nowMs: NOW, maxAgeMs: 30_000, maxFutureSkewMs,
    });
    assertEquals(result.status, "REJECTED");
  }
});

Deno.test("rechaza identificadores, resultados y casas vacíos", () => {
  assertEquals(validateOpportunity([
    offer("home", 2.1, { eventId: "   " }),
    offer("draw", 2.2),
    offer("away", 2.3),
  ], ["home", "draw", "away"], { nowMs: NOW, maxAgeMs: 30_000 }).status, "REJECTED");

  assertEquals(validateOpportunity([
    total("over", 2.1),
    total("under", 2.2, { bookmaker: "  " }),
  ], ["over", "under"], { nowMs: NOW, maxAgeMs: 30_000 }).status, "REJECTED");
});

Deno.test("rechaza líneas inválidas y prioriza datos inválidos sobre caducidad", () => {
  assertEquals(validateOpportunity([
    total("over", 2.1, { line: Number.NaN }),
    total("under", 2.2, { line: Number.NaN }),
  ], ["over", "under"], { nowMs: NOW, maxAgeMs: 30_000 }).status, "REJECTED");

  assertEquals(validateOpportunity([
    total("over", 2.1, { capturedAtMs: NOW - 60_000 }),
    total("under", 1, { capturedAtMs: NOW - 60_000 }),
  ], ["over", "under"], { nowMs: NOW, maxAgeMs: 30_000 }).status, "REJECTED");
});

Deno.test("el flujo completo rechaza 1X2 incompleto y calcula uno completo", () => {
  const bad = evaluateSurebet([
    offer("home", 2.6), offer("away", 3.1),
  ], 100, { nowMs: NOW, maxAgeMs: 30_000 });
  assertEquals(bad.validation.status, "REJECTED");
  assertEquals(bad.calculation, null);
  assertEquals(bad.allocations, null);

  const good = evaluateSurebet([
    offer("home", 2.6), offer("draw", 3.7), offer("away", 3.1),
  ], 100, { nowMs: NOW, maxAgeMs: 30_000 });
  assertEquals(good.validation.status, "VALIDATED");
  if (!good.calculation || !good.allocations) {
    throw new Error("Se esperaba cálculo y reparto");
  }
  assertEquals(
    good.allocations.reduce((sum, item) => sum + Math.round(item.stake * 100), 0),
    10_000,
  );
});

Deno.test("el resultado validado no comparte referencias mutables con la entrada", () => {
  const original = [offer("home", 2.1), offer("draw", 3.5), offer("away", 3.8)];
  const result = validateOpportunity(original, ["home", "draw", "away"], {
    nowMs: NOW, maxAgeMs: 30_000,
  });
  assertEquals(result.status, "VALIDATED");
  original[0].odds = 1.01;
  assertEquals(result.offers[0].odds, 2.1);
});
