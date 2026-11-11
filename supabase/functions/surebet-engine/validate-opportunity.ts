import type { OddsOffer, ValidationResult } from "./types.ts";

/** Valida identidad, mercado, cobertura, cuotas y frescura antes del cálculo. */
export function validateOpportunity(
  offers: readonly OddsOffer[],
  expectedSelectionKeys: readonly string[],
  options: { nowMs: number; maxAgeMs: number; maxFutureSkewMs?: number },
): ValidationResult {
  const rejected = (reason: string): ValidationResult => ({
    status: "REJECTED",
    reason,
    offers: [],
  });

  if (!Number.isFinite(options.nowMs) || !Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
    return rejected("Configuración temporal inválida");
  }
  if (offers.length < 2 || expectedSelectionKeys.length < 2) {
    return rejected("Se necesitan al menos dos resultados");
  }

  const expected = new Set(expectedSelectionKeys);
  if (expected.size !== expectedSelectionKeys.length || expected.has("")) {
    return rejected("La lista de resultados esperados no es válida");
  }

  const first = offers[0];
  if (!first.eventId || !first.marketKey || !first.period) {
    return rejected("Falta identidad canónica del evento o del mercado");
  }

  const seen = new Set<string>();
  for (const offer of offers) {
    if (
      offer.eventId !== first.eventId ||
      offer.marketKey !== first.marketKey ||
      offer.period !== first.period ||
      offer.line !== first.line
    ) return rejected("Se han mezclado eventos, mercados, periodos o líneas");

    if (!expected.has(offer.selectionKey) || seen.has(offer.selectionKey)) {
      return rejected("Resultados duplicados o no esperados");
    }
    if (!offer.bookmaker || !Number.isFinite(offer.odds) || offer.odds <= 1) {
      return rejected("Casa o cuota decimal inválida");
    }
    if (!Number.isFinite(offer.capturedAtMs)) return rejected("Fecha de captura inválida");

    const ageMs = options.nowMs - offer.capturedAtMs;
    const futureSkew = options.maxFutureSkewMs ?? 5_000;
    if (ageMs < -futureSkew) return rejected("La captura tiene una fecha futura anómala");
    if (ageMs > options.maxAgeMs) {
      return { status: "EXPIRED", reason: "Las cuotas han caducado", offers: [] };
    }
    seen.add(offer.selectionKey);
  }

  if (seen.size !== expected.size || [...expected].some((key) => !seen.has(key))) {
    return rejected("No están cubiertos todos los resultados del mercado");
  }

  return { status: "VALIDATED", offers: [...offers] };
}
