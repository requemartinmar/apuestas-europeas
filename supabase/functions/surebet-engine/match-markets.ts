import type { OddsOffer } from "./types.ts";
import { isExactMarketCoverage } from "./market-rules.ts";

/**
 * Escoge la mejor cuota de cada resultado sin mezclar eventos, mercados,
 * periodos o líneas. Solo acepta mercados con cobertura definida por el motor.
 */
export function selectBestCompleteMarketOffers(
  offers: readonly OddsOffer[],
  expectedSelectionKeys: readonly string[],
): OddsOffer[] | null {
  if (!Array.isArray(offers) || offers.length === 0 ||
      !Array.isArray(expectedSelectionKeys)) return null;

  const first = offers[0];
  if (!first || !isExactMarketCoverage(
    first.marketKey,
    first.line,
    expectedSelectionKeys,
  )) return null;
  if (
    !first.eventId || !first.marketKey || !first.period ||
    typeof first.eventId !== "string" ||
    typeof first.marketKey !== "string" ||
    typeof first.period !== "string"
  ) return null;

  const expected = [...expectedSelectionKeys];
  const best = new Map<string, OddsOffer>();
  for (const offer of offers) {
    if (
      offer.eventId !== first.eventId ||
      offer.marketKey !== first.marketKey ||
      offer.period !== first.period ||
      offer.line !== first.line
    ) continue;
    if (!expected.includes(offer.selectionKey)) continue;
    if (typeof offer.odds !== "number" ||
        !Number.isFinite(offer.odds) || offer.odds <= 1) continue;
    if (typeof offer.bookmaker !== "string" ||
        offer.bookmaker.trim().length === 0) continue;

    const current = best.get(offer.selectionKey);
    if (!current || offer.odds > current.odds) best.set(offer.selectionKey, offer);
  }

  if (best.size !== expected.length) return null;
  return expected.map((key) => Object.freeze({ ...best.get(key)! }));
}
