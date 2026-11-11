import type { OddsOffer, StakeAllocation } from "./types.ts";

/**
 * Distribuye el stake en céntimos usando el reparto óptimo proporcional a 1/cuota.
 * El método de mayores restos garantiza que la suma asignada coincide exactamente
 * con el presupuesto en céntimos.
 */
export function calculateStakes(
  offers: readonly OddsOffer[],
  totalStake: number,
): StakeAllocation[] | null {
  if (!Number.isFinite(totalStake) || totalStake <= 0 || offers.length < 2) return null;

  const totalCents = Math.round(totalStake * 100);
  if (totalCents < offers.length) return null;

  const seen = new Set<string>();
  let inverseSum = 0;
  for (const offer of offers) {
    if (!offer.selectionKey || seen.has(offer.selectionKey)) return null;
    if (!Number.isFinite(offer.odds) || offer.odds <= 1) return null;
    seen.add(offer.selectionKey);
    inverseSum += 1 / offer.odds;
  }
  if (!Number.isFinite(inverseSum) || inverseSum >= 1) return null;

  const parts = offers.map((offer, index) => {
    const exactCents = totalCents * ((1 / offer.odds) / inverseSum);
    const floorCents = Math.floor(exactCents);
    return { offer, index, cents: floorCents, remainder: exactCents - floorCents };
  });

  let remaining = totalCents - parts.reduce((sum, part) => sum + part.cents, 0);
  const byRemainder = [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i++) byRemainder[i].cents += 1;

  const allocations = parts.map(({ offer, cents }) => ({
    selectionKey: offer.selectionKey,
    bookmaker: offer.bookmaker,
    odds: offer.odds,
    stake: cents / 100,
    payout: Math.round((cents / 100) * offer.odds * 100) / 100,
  }));

  // Una asignación que pierde por el redondeo no se presenta como arbitraje rentable.
  const minPayout = Math.min(...allocations.map((item) => item.payout));
  if (minPayout <= totalCents / 100) return null;

  return allocations;
}
