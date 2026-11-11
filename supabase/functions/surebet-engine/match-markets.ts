import type { OddsOffer } from "./types.ts";

/**
 * Escoge la mejor cuota de cada resultado sin mezclar eventos, mercados,
 * periodos o líneas. eventId debe proceder de una identidad/crosswalk fiable.
 */
export function selectBestCompleteMarketOffers(
  offers: readonly OddsOffer[],
  expectedSelectionKeys: readonly string[],
): OddsOffer[] | null {
  if (offers.length === 0 || expectedSelectionKeys.length < 2) return null;

  const expected = [...new Set(expectedSelectionKeys)];
  if (expected.length !== expectedSelectionKeys.length || expected.some((key) => !key)) return null;

  const first = offers[0];
  if (!first.eventId || !first.marketKey || !first.period) return null;

  const best = new Map<string, OddsOffer>();
  for (const offer of offers) {
    if (
      offer.eventId !== first.eventId ||
      offer.marketKey !== first.marketKey ||
      offer.period !== first.period ||
      offer.line !== first.line
    ) continue;
    if (!expected.includes(offer.selectionKey)) continue;
    if (!Number.isFinite(offer.odds) || offer.odds <= 1) continue;

    const current = best.get(offer.selectionKey);
    if (!current || offer.odds > current.odds) best.set(offer.selectionKey, offer);
  }

  if (best.size !== expected.length) return null;
  return expected.map((key) => best.get(key)!);
}
