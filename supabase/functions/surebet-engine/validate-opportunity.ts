import type { OddsOffer, ValidationResult } from "./types.ts";
import { isExactMarketCoverage } from "./market-rules.ts";

/** Valida cobertura autoritativa, identidad, cuotas y frescura antes del cálculo. */
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
  ) return rejected("Configuración temporal inválida");

  if (!Array.isArray(offers) || offers.length < 2) {
    return rejected("Se necesitan al menos dos resultados");
  }
  if (!Array.isArray(expectedSelectionKeys) ||
      expectedSelectionKeys.some((key) => typeof key !== "string")) {
    return rejected("La lista de resultados esperados no es válida");
  }

  const first = offers[0];
  if (
    !first || typeof first.eventId !== "string" ||
    first.eventId.trim().length === 0 ||
    typeof first.marketKey !== "string" ||
    first.marketKey.trim().length === 0 ||
    typeof first.period !== "string" || first.period.trim().length === 0 ||
    (first.line !== null &&
      (typeof first.line !== "number" || !Number.isFinite(first.line)))
  ) return rejected("Falta identidad canónica del evento o del mercado");

  // La cobertura procede de reglas internas, no de una lista elegida por el llamante.
  if (!isExactMarketCoverage(
    first.marketKey,
    first.line,
    expectedSelectionKeys,
  )) {
    return rejected("La cobertura declarada no coincide con los resultados obligatorios del mercado");
  }

  const required = new Set(expectedSelectionKeys);
  const seen = new Set<string>();
  let hasExpiredOffer = false;

  for (const offer of offers) {
    if (!offer || typeof offer !== "object") {
      return rejected("Oferta inválida");
    }
    if (
      offer.eventId !== first.eventId ||
      offer.marketKey !== first.marketKey ||
      offer.period !== first.period ||
      offer.line !== first.line
    ) return rejected("Se han mezclado eventos, mercados, periodos o líneas");

    if (
      typeof offer.selectionKey !== "string" ||
      offer.selectionKey.trim().length === 0 ||
      !required.has(offer.selectionKey) ||
      seen.has(offer.selectionKey)
    ) return rejected("Resultados duplicados o no esperados");

    if (
      typeof offer.bookmaker !== "string" ||
      offer.bookmaker.trim().length === 0 ||
      typeof offer.odds !== "number" ||
      !Number.isFinite(offer.odds) ||
      offer.odds <= 1
    ) return rejected("Casa o cuota decimal inválida");

    if (typeof offer.capturedAtMs !== "number" ||
        !Number.isFinite(offer.capturedAtMs)) {
      return rejected("Fecha de captura inválida");
    }

    const ageMs = options.nowMs - offer.capturedAtMs;
    if (ageMs < -futureSkew) {
      return rejected("La captura tiene una fecha futura anómala");
    }
    if (ageMs > options.maxAgeMs) hasExpiredOffer = true;
    seen.add(offer.selectionKey);
  }

  if (seen.size !== required.size ||
      [...required].some((key) => !seen.has(key))) {
    return rejected("No están cubiertos todos los resultados del mercado");
  }
  if (hasExpiredOffer) {
    return { status: "EXPIRED", reason: "Las cuotas han caducado", offers: [] };
  }

  // Copia defensiva también de cada oferta: el llamante no puede mutar los objetos originales.
  return {
    status: "VALIDATED",
    offers: offers.map((offer) => Object.freeze({ ...offer })),
  };
}
