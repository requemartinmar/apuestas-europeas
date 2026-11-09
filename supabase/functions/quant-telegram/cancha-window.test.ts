import { CANCHA_LOOKAHEAD_DAYS, buildNoUpcomingCanchaMessage, getCanchaWindow } from "./cancha-window.ts";

Deno.test("Cancha consulta exactamente los próximos 21 días", () => {
  const now = new Date("2026-11-09T18:00:00.000Z");
  const window = getCanchaWindow(now);
  if (window.start !== "2026-11-09T18:00:00.000Z") throw new Error("Inicio incorrecto");
  if (window.end !== "2026-11-30T18:00:00.000Z") throw new Error("Fin incorrecto");
  if (CANCHA_LOOKAHEAD_DAYS !== 21) throw new Error("La ventana debe ser de 21 días");
});

Deno.test("Cancha rechaza fechas inválidas", () => {
  let rejected = false;
  try { getCanchaWindow(new Date("fecha-inválida")); } catch { rejected = true; }
  if (!rejected) throw new Error("Se esperaba rechazar una fecha inválida");
});

Deno.test("mensaje sin partidos explica el posible parón y evita inventar predicciones", () => {
  const message = buildNoUpcomingCanchaMessage();
  if (!message.includes("21 días")) throw new Error("Debe indicar la ventana consultada");
  if (!message.includes("parón de selecciones")) throw new Error("Debe explicar el posible parón");
  if (!message.includes("encuentros verificados")) throw new Error("Debe evitar predicciones sin partidos");
});
