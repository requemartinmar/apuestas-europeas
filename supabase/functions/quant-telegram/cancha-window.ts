export const CANCHA_LOOKAHEAD_DAYS = 1;
const TZ = "Europe/Madrid";
function calendarDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function addCalendarDays(dateText: string, days: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function madridMidnightUtc(dateText: string): Date {
  const [year, month, day] = dateText.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    guess += target - represented;
  }
  return new Date(guess);
}
export function getCanchaWindow(now: Date): { start: string; end: string } {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("La fecha de referencia de Cancha no es válida");
  const tomorrow = addCalendarDays(calendarDate(now), 1);
  const followingDay = addCalendarDays(tomorrow, 1);
  return { start: madridMidnightUtc(tomorrow).toISOString(), end: madridMidnightUtc(followingDay).toISOString() };
}
export function buildNoUpcomingCanchaMessage(): string {
  return ["No hay partidos pendientes registrados para mañana.",
    "Puede deberse a un parón o a que el calendario todavía no se ha actualizado.",
    "No se generarán predicciones sin encuentros verificados."].join("\n");
}
