import { assertEquals, assertAlmostEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateSurebet } from "./calculate-surebet.ts";
import { calculateStakes } from "./calculate-stakes.ts";
import { selectBestCompleteMarketOffers } from "./match-markets.ts";
import { validateOpportunity } from "./validate-opportunity.ts";
import type { OddsOffer } from "./types.ts";

const NOW = 1_800_000_000_000;
const offer = (selectionKey: string, odds: number, overrides: Partial<OddsOffer> = {}): OddsOffer => ({
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

Deno.test("detecta arbitraje de dos resultados", () => {
  const result = calculateSurebet([offer("home", 2.1), offer("away", 2.05)], 100);
  if (!result) throw new Error("Se esperaba oportunidad");
  assertAlmostEquals(result.inverseOddsSum, 0.96399535, 0.0000001);
  assertAlmostEquals(result.theoreticalProfitPercent, 3.73494, 0.001);
});

Deno.test("detecta arbitraje 1X2 con cobertura de tres resultados", () => {
  const result = calculateSurebet([
    offer("home", 2.6), offer("draw", 3.7), offer("away", 3.1),
  ], 100);
  if (!result) throw new Error("Se esperaba oportunidad 1X2");
  assertAlmostEquals(result.inverseOddsSum, 0.97747, 0.00002);
});

Deno.test("rechaza mercado sin arbitraje y cuotas inválidas", () => {
  assertEquals(calculateSurebet([offer("home", 1.9), offer("away", 1.9)], 100), null);
  assertEquals(calculateSurebet([offer("home", 2), offer("away", 1)], 100), null);
  assertEquals(calculateSurebet([offer("home", 2), offer("home", 3)], 100), null);
});

Deno.test("reparte stake en céntimos y conserva el presupuesto", () => {
  const allocations = calculateStakes([offer("home", 2.1), offer("away", 2.05)], 100);
  if (!allocations) throw new Error("Se esperaba reparto");
  assertEquals(allocations.reduce((sum, item) => sum + Math.round(item.stake * 100), 0), 10_000);
  assertAlmostEquals(allocations[0].stake, 49.4, 0.02);
  assertAlmostEquals(allocations[1].stake, 50.6, 0.02);
  assertEquals(allocations.every((item) => item.payout > 100), true);
});

Deno.test("rechaza si el redondeo o el presupuesto no permite beneficio garantizado", () => {
  assertEquals(calculateStakes([offer("home", 2), offer("away", 2)], 100), null);
  assertEquals(calculateStakes([offer("home", 2.1), offer("away", 2.05)], 0.01), null);
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

Deno.test("no completa un mercado si falta un resultado", () => {
  assertEquals(selectBestCompleteMarketOffers([offer("home", 2.2), offer("away", 2.1)], ["home", "draw", "away"]), null);
});

Deno.test("valida un mercado completo y reciente", () => {
  const result = validateOpportunity(
    [offer("home", 2.1), offer("draw", 3.5), offer("away", 3.8)],
    ["home", "draw", "away"],
    { nowMs: NOW, maxAgeMs: 30_000 },
  );
  assertEquals(result.status, "VALIDATED");
});

Deno.test("rechaza mezcla de mercados y caduca cuotas antiguas", () => {
  const mixed = validateOpportunity(
    [offer("home", 2.1), offer("away", 2.2, { period: "1H" })],
    ["home", "away"],
    { nowMs: NOW, maxAgeMs: 30_000 },
  );
  assertEquals(mixed.status, "REJECTED");

  const expired = validateOpportunity(
    [offer("home", 2.1, { capturedAtMs: NOW - 60_000 }), offer("away", 2.2)],
    ["home", "away"],
    { nowMs: NOW, maxAgeMs: 30_000 },
  );
  assertEquals(expired.status, "EXPIRED");
  assertNotEquals(expired.reason, undefined);
});
