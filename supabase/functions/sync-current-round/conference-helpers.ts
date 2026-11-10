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

/** Convierte hora civil española a UTC usando la regla CET/CEST de Europe/Madrid. */
export function madridLocalTimeToUtc(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Fecha u hora local inválida");
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error("Fecha u hora local fuera de rango");
  }
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = target;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const representedAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    const delta = target - representedAsUtc;
    candidate += delta;
    if (delta === 0) break;
  }
  const check = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
  if (Number(check.year) !== year || Number(check.month) !== month || Number(check.day) !== day ||
      Number(check.hour) !== hour || Number(check.minute) !== minute) {
    throw new Error("La hora local no existe en Europe/Madrid por el cambio horario");
  }
  return new Date(candidate).toISOString();
}
