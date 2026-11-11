/** Tipos del motor surebet aislado. No depende de quant-telegram ni de proveedores. */

export interface OddsOffer {
  /** ID canónico compartido del evento; no usar coincidencias aproximadas de nombres. */
  eventId: string;
  eventName: string;
  /** Identificador canónico del mercado, por ejemplo "1x2" o "totals". */
  marketKey: string;
  /** Periodo explícito: "FT", "1H", etc. */
  period: string;
  /** Línea del mercado; null para mercados sin línea. */
  line: number | null;
  /** Clave canónica del resultado: "home", "draw", "away", "over", "under", etc. */
  selectionKey: string;
  bookmaker: string;
  /** Cuota decimal bruta, antes de comisiones. */
  odds: number;
  /** Instante de captura Unix en milisegundos. */
  capturedAtMs: number;
}

export interface StakeAllocation {
  selectionKey: string;
  bookmaker: string;
  odds: number;
  stake: number;
  payout: number;
}

export interface SurebetCalculation {
  status: "THEORETICAL";
  inverseOddsSum: number;
  theoreticalProfitPercent: number;
  totalStake: number;
}

export type OpportunityStatus = "REJECTED" | "THEORETICAL" | "VALIDATED" | "EXPIRED";

export interface ValidationResult {
  status: OpportunityStatus;
  reason?: string;
  offers: OddsOffer[];
}
