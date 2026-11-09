export const CANCHA_LOOKAHEAD_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

export function getCanchaWindow(now: Date): { start: string; end: string } {
  const timestamp = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new RangeError("La fecha de referencia de Cancha no es válida");
  return {
    start: new Date(timestamp).toISOString(),
    end: new Date(timestamp + CANCHA_LOOKAHEAD_DAYS * DAY_MS).toISOString(),
  };
}

export function buildNoUpcomingCanchaMessage(): string {
  return [
    "No hay partidos registrados en Cancha en los próximos " + CANCHA_LOOKAHEAD_DAYS + " días.",
    "Puede deberse a un parón de selecciones o a que el calendario todavía no se ha actualizado.",
    "No se generarán predicciones sin encuentros verificados. Vuelve a consultar más adelante.",
  ].join("\n");
}
