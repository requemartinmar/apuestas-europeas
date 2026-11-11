import type { OddsOffer, StakeAllocation } from "./types.ts";

/**
 * Distribuye el stake en céntimos usando el reparto óptimo proporcional a 1/cuota.
 * El método de mayores restos conserva exactamente el presupuesto en céntimos.
 */
export function calculateStakes(
  offers: readonly OddsOffer[],
  totalStake: number,
): StakeAllocation[] | null {
  if (!Number.isFinite(totalStake) || totalStake <= 0 || offers.length < 2) return null;

  const rawTotalCents = totalStake * 100;
  const totalCents = Math.round(rawTotalCents);
  // No redondear silenciosamente importes con fracciones inferiores a un céntimo.
  if (
    !Number.isSafeInteger(totalCents) ||
    Math.abs(rawTotalCents - totalCents) > 1e-7 ||
    totalCents < offers.length
  ) return null;

  const seen = new Set<string>();
  let inverseSum = 0;
  for (const offer of offers) {
    if (
      typeof offer.selectionKey !== "string" ||
      offer.selectionKey.trim().length === 0 ||
      seen.has(offer.selectionKey) ||
      typeof offer.bookmaker !== "string" ||
      offer.bookmaker.trim().length === 0 ||
      !Number.isFinite(offer.odds) ||
      offer.odds <= 1
    ) return null;
    seen.add(offer.selectionKey);
    inverseSum += 1 / offer.odds;
  }
  if (!Number.isFinite(inverseSum) || inverseSum >= 1) return null;

  const exactShares = offers.map(
    (offer) => totalCents * ((1 / offer.odds) / inverseSum),
  );
  if (exactShares.some((share) => !Number.isFinite(share) || share < 0)) return null;

  const parts = offers.map((offer, index) => {
    const exactCents = exactShares[index];
    const floorCents = Math.floor(exactCents);
    return { offer, index, cents: floorCents, remainder: exactCents - floorCents };
  });

  const assignedCents = parts.reduce((sum, part) => sum + part.cents, 0);
  const remaining = totalCents - assignedCents;
  if (!Number.isSafeInteger(assignedCents) || remaining < 0 || remaining >= parts.length) return null;

  const byRemainder = [...parts].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (let i = 0; i < remaining; i++) byRemainder[i].cents += 1;

  const allocations: StakeAllocation[] = [];
  for (const { offer, cents } of parts) {
    const payoutCents = Math.round(cents * offer.odds);
    if (!Number.isSafeInteger(payoutCents) || payoutCents < 0) return null;
    allocations.push({
      selectionKey: offer.selectionKey,
      bookmaker: offer.bookmaker,
      odds: offer.odds,
      stake: cents / 100,
      payout: payoutCents / 100,
    });
  }

  const allocatedCents = allocations.reduce(
    (sum, item) => sum + Math.round(item.stake * 100),
    0,
  );
  if (allocatedCents !== totalCents) return null;

  // El peor cobro, redondeado a céntimos, debe superar el presupuesto total.
  const minPayout = Math.min(...allocations.map((item) => item.payout));
  if (minPayout <= totalCents / 100) return null;

  return allocations;
}
