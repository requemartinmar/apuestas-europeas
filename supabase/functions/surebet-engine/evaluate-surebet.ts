import { calculateStakes } from "./calculate-stakes.ts";
import { calculateSurebet } from "./calculate-surebet.ts";
import { selectBestCompleteMarketOffers } from "./match-markets.ts";
import { getRequiredSelectionKeys } from "./market-rules.ts";
import { validateOpportunity } from "./validate-opportunity.ts";
import type { OddsOffer, StakeAllocation, SurebetCalculation, ValidationResult } from "./types.ts";

export interface EvaluateSurebetResult {
  validation: ValidationResult;
  calculation: SurebetCalculation | null;
  allocations: StakeAllocation[] | null;
}

/**
 * Flujo recomendado: reglas del mercado -> selección -> validación -> cálculo
 * -> reparto en céntimos. La lista de resultados nunca la decide el llamante.
 */
export function evaluateSurebet(
  offers: readonly OddsOffer[],
  totalStake: number,
  options: { nowMs: number; maxAgeMs: number; maxFutureSkewMs?: number },
): EvaluateSurebetResult {
  const first = offers[0];
  const required = first
    ? getRequiredSelectionKeys(first.marketKey, first.line)
    : null;

  if (!required) {
    return {
      validation: {
        status: "REJECTED",
        reason: "Mercado desconocido o línea incompatible con el mercado",
        offers: [],
      },
      calculation: null,
      allocations: null,
    };
  }

  const selected = selectBestCompleteMarketOffers(offers, required);
  if (!selected) {
    return {
      validation: {
        status: "REJECTED",
        reason: "No se han encontrado cuotas para cubrir todos los resultados",
        offers: [],
      },
      calculation: null,
      allocations: null,
    };
  }

  const validation = validateOpportunity(selected, required, options);
  if (validation.status !== "VALIDATED") {
    return { validation, calculation: null, allocations: null };
  }

  const calculation = calculateSurebet(validation.offers, totalStake);
  if (!calculation) {
    return {
      validation: {
        status: "REJECTED",
        reason: "Las cuotas no generan arbitraje matemático",
        offers: [],
      },
      calculation: null,
      allocations: null,
    };
  }

  const allocations = calculateStakes(validation.offers, totalStake);
  if (!allocations) {
    return {
      validation: {
        status: "REJECTED",
        reason: "El reparto en céntimos no garantiza beneficio tras redondear",
        offers: [],
      },
      calculation: null,
      allocations: null,
    };
  }

  return { validation, calculation, allocations };
}
