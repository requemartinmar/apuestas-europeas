/** Helpers puros para importar Conference League. */
export const MAX_API_FOOTBALL_PAGES = 20;

/** Hash estable de 48 bits; cabe con los offsets internos dentro de Number.MAX_SAFE_INTEGER. */
export function stableHash(value: string): number {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9|]/g, "");
  let hash = 14695981039346656037n;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= BigInt(normalized.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return Number(hash & ((1n << 48n) - 1n));
}

/** Open-matchday documenta date en UTC y time con offset fijo UTC+1 (convención CET-1), también en verano. */
export function openMatchdayTimeToUtc(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Fecha u hora de Open-matchday inválida");
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error("Fecha u hora de Open-matchday fuera de rango");
  }
  const dateCheck = new Date(Date.UTC(year, month - 1, day));
  if (dateCheck.getUTCFullYear() !== year || dateCheck.getUTCMonth() !== month - 1 || dateCheck.getUTCDate() !== day) {
    throw new Error("Fecha de Open-matchday inválida");
  }
  // El CSV usa un offset fijo +01:00: convertir la hora local del fichero a UTC resta una hora.
  return new Date(Date.UTC(year, month - 1, day, hour - 1, minute)).toISOString();
}
