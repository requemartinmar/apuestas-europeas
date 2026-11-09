import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatUpcomingFixturesMessages } from "./upcoming-fixtures.ts";

const now = new Date("2026-11-09T18:00:00Z");

function fixture(date: string, home = "Equipo A", away = "Equipo B") {
  return {
    fecha_utc: date,
    equipo_local: { nombre: home },
    equipo_visitante: { nombre: away },
    competicion: { nombre: "Liga de prueba" },
  };
}

Deno.test("muestra próximos partidos sin probabilidades", () => {
  const messages = formatUpcomingFixturesMessages([
    fixture("2026-11-20T19:30:00Z", "Bayern", "Köln"),
  ], now);

  assertEquals(messages.length, 1);
  assertStringIncludes(messages[0], "Bayern");
  assertStringIncludes(messages[0], "Köln");
  assertStringIncludes(messages[0], "sin probabilidades");
  assertEquals(messages[0].includes("%"), false);
});

Deno.test("excluye partidos de hoy", () => {
  const messages = formatUpcomingFixturesMessages([
    fixture("2026-11-09T20:00:00Z"),
  ], now);

  assertStringIncludes(messages[0], "No hay próximos partidos");
});

Deno.test("incluye los 48 partidos y los divide en mensajes seguros para Telegram", () => {
  const matches = Array.from({ length: 48 }, (_, index) =>
    fixture(
      new Date(Date.parse("2026-11-10T12:00:00Z") + index * 3600000).toISOString(),
      `Local${index}`,
      `Visitante${index}`,
    )
  );

  const messages = formatUpcomingFixturesMessages(matches, now, 21, 1800);
  const combined = messages.join("\n");

  assertEquals((combined.match(/⚽/g) ?? []).length, 48);
  assertStringIncludes(combined, "Local0");
  assertStringIncludes(combined, "Local47");
  assertEquals(messages.every((message) => message.length <= 1800), true);
  assertEquals(messages.length > 1, true);
  assertStringIncludes(messages[0], "(1/");
});

Deno.test("ordena cronológicamente todos los partidos", () => {
  const matches = [
    fixture("2026-11-12T12:00:00Z", "Tercero", "Visitante3"),
    fixture("2026-11-10T12:00:00Z", "Primero", "Visitante1"),
    fixture("2026-11-11T12:00:00Z", "Segundo", "Visitante2"),
  ];

  const messages = formatUpcomingFixturesMessages(matches, now);
  const result = messages.join("\n");
  assertEquals(result.indexOf("Primero") < result.indexOf("Segundo"), true);
  assertEquals(result.indexOf("Segundo") < result.indexOf("Tercero"), true);
});

Deno.test("escapa nombres HTML y descarta datos incompletos", () => {
  const messages = formatUpcomingFixturesMessages([
    fixture("2026-11-20T19:30:00Z", "<Bayern>", "Köln & amigos"),
    fixture("2026-11-21T19:30:00Z", "", "Sin local"),
    fixture("fecha incorrecta"),
  ], now);

  const result = messages.join("\n");
  assertStringIncludes(result, "&lt;Bayern&gt;");
  assertStringIncludes(result, "Köln &amp; amigos");
  assertEquals(result.includes("Sin local"), false);
});
