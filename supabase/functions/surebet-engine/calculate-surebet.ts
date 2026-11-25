import type { OddsOffer, SurebetCalculation } from "./types.ts";

/**
 * Primitiva matemática: no acredita cobertura de un mercado.
 * Para un resultado seguro de extremo a extremo usar evaluateSurebet().
 */
export function calculateSurebet(
  offers: readonly OddsOffer[],
  totalStake: number,
): SurebetCalculation | null {
  if (!Number.isFinite(totalStake) || totalStake <= 0 ||
      !Array.isArray(offers) || offers.length < 2) return null;

  const seen = new Set<string>();
  let inverseOddsSum = 0;
  for (const offer of offers) {
    if (!offer || typeof offer.selectionKey !== "string" ||
        offer.selectionKey.trim().length === 0 ||
        seen.has(offer.selectionKey) ||
        typeof offer.odds !== "number" ||
        !Number.isFinite(offer.odds) || offer.odds <= 1) return null;
    seen.add(offer.selectionKey);
    inverseOddsSum += 1 / offer.odds;
  }

  if (!Number.isFinite(inverseOddsSum) || inverseOddsSum <= 0 ||
      inverseOddsSum >= 1) return null;

  const theoreticalProfitPercent = (1 / inverseOddsSum - 1) * 100;
  if (!Number.isFinite(theoreticalProfitPercent) ||
      theoreticalProfitPercent <= 0) return null;

  return {
    status: "THEORETICAL",
    inverseOddsSum,
    theoreticalProfitPercent,
    totalStake,
  };
}
