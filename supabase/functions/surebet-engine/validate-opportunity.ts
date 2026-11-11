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

  const futureSkew = options.maxFutureSkewMs ?? 5_000;
  if (
    !Number.isFinite(options.nowMs) ||
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs < 0 ||
    !Number.isFinite(futureSkew) ||
    futureSkew < 0
  ) {
    return rejected("Configuración temporal inválida");
  }
  if (offers.length < 2 || expectedSelectionKeys.length < 2) {
    return rejected("Se necesitan al menos dos resultados");
  }

  const expected = new Set(expectedSelectionKeys);
  if (
    expected.size !== expectedSelectionKeys.length ||
    expectedSelectionKeys.some((key) =>
      typeof key !== "string" || key.trim().length === 0
    )
  ) {
    return rejected("La lista de resultados esperados no es válida");
  }

  const first = offers[0];
  if (
    typeof first.eventId !== "string" || first.eventId.trim().length === 0 ||
    typeof first.marketKey !== "string" ||
    first.marketKey.trim().length === 0 ||
    typeof first.period !== "string" || first.period.trim().length === 0 ||
    (first.line !== null && !Number.isFinite(first.line))
  ) {
    return rejected("Falta identidad canónica del evento o del mercado");
  }

  const seen = new Set<string>();
  let hasExpiredOffer = false;

  for (const offer of offers) {
    if (
      offer.eventId !== first.eventId ||
      offer.marketKey !== first.marketKey ||
      offer.period !== first.period ||
      offer.line !== first.line
    ) return rejected("Se han mezclado eventos, mercados, periodos o líneas");

    if (
      typeof offer.selectionKey !== "string" ||
      offer.selectionKey.trim().length === 0 ||
      !expected.has(offer.selectionKey) ||
      seen.has(offer.selectionKey)
    ) {
      return rejected("Resultados duplicados o no esperados");
    }
    if (
      typeof offer.bookmaker !== "string" ||
      offer.bookmaker.trim().length === 0 ||
      !Number.isFinite(offer.odds) ||
      offer.odds <= 1
    ) {
      return rejected("Casa o cuota decimal inválida");
    }
    if (!Number.isFinite(offer.capturedAtMs)) {
      return rejected("Fecha de captura inválida");
    }

    const ageMs = options.nowMs - offer.capturedAtMs;
    if (ageMs < -futureSkew) {
      return rejected("La captura tiene una fecha futura anómala");
    }
    if (ageMs > options.maxAgeMs) hasExpiredOffer = true;
    seen.add(offer.selectionKey);
  }

  if (
    seen.size !== expected.size || [...expected].some((key) => !seen.has(key))
  ) {
    return rejected("No están cubiertos todos los resultados del mercado");
  }
  if (hasExpiredOffer) {
    return { status: "EXPIRED", reason: "Las cuotas han caducado", offers: [] };
  }

  return { status: "VALIDATED", offers: [...offers] };
}
