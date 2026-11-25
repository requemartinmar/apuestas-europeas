import type { OddsOffer } from "./types.ts";

/**
 * Lista cerrada de mercados cuya cobertura conocemos.
 * Un mercado desconocido se rechaza: nunca se infiere cobertura desde el llamante.
 */
const MARKET_OUTCOMES: Readonly<Record<string, readonly string[]>> = {
  "1x2": ["home", "draw", "away"],
  "totals": ["over", "under"],
  "btts": ["yes", "no"],
};

/** Devuelve los resultados obligatorios para el mercado y línea indicados. */
export function getRequiredSelectionKeys(
  marketKey: string,
  line: number | null,
): readonly string[] | null {
  if (typeof marketKey !== "string") return null;
  const key = marketKey.trim().toLowerCase();
  const outcomes = MARKET_OUTCOMES[key];
  if (!outcomes) return null;

  if (key === "totals") {
    if (line === null || !Number.isFinite(line) || line < 0) return null;
  } else if (line !== null) {
    return null;
  }
  return outcomes;
}

/** La lista externa debe coincidir exactamente con la definición del motor. */
export function isExactMarketCoverage(
  marketKey: string,
  line: number | null,
  selectionKeys: readonly string[],
): boolean {
  const required = getRequiredSelectionKeys(marketKey, line);
  if (!required || selectionKeys.length !== required.length) return false;
  const supplied = new Set(selectionKeys);
  return supplied.size === required.length &&
    required.every((key) => supplied.has(key));
}
