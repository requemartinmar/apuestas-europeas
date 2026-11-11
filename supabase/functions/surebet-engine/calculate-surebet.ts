import type { OddsOffer, SurebetCalculation } from "./types.ts";

/**
 * Detecta arbitraje matemático con cobertura completa.
 * Requiere exactamente una cuota por resultado; la validación de identidad/cobertura
 * corresponde a validate-opportunity.ts.
 */
export function calculateSurebet(
  offers: readonly OddsOffer[],
  totalStake: number,
): SurebetCalculation | null {
  if (!Number.isFinite(totalStake) || totalStake <= 0 || offers.length < 2) {
    return null;
  }

  const seen = new Set<string>();
  let inverseOddsSum = 0;

  for (const offer of offers) {
    if (!offer.selectionKey || seen.has(offer.selectionKey)) return null;
    if (!Number.isFinite(offer.odds) || offer.odds <= 1) return null;
    seen.add(offer.selectionKey);
    inverseOddsSum += 1 / offer.odds;
  }

  if (!Number.isFinite(inverseOddsSum) || inverseOddsSum >= 1) return null;

  return {
    status: "THEORETICAL",
    inverseOddsSum,
    theoreticalProfitPercent: (1 / inverseOddsSum - 1) * 100,
    totalStake,
  };
}
