import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatUpcomingFixtures } from "./upcoming-fixtures.ts";

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
  const result = formatUpcomingFixtures([
    fixture("2026-11-20T19:30:00Z", "Bayern", "Köln"),
  ], now);

  assertStringIncludes(result, "Bayern");
  assertStringIncludes(result, "Köln");
  assertStringIncludes(result, "sin probabilidades");
  assertEquals(result.includes("%"), false);
});

Deno.test("excluye partidos de hoy", () => {
  const result = formatUpcomingFixtures([
    fixture("2026-11-09T20:00:00Z"),
  ], now);

  assertStringIncludes(result, "No hay próximos partidos");
});

Deno.test("ordena cronológicamente y limita a 20", () => {
  const matches = Array.from({ length: 25 }, (_, index) =>
    fixture(
      new Date(Date.parse("2026-11-10T12:00:00Z") + (24-index) * 3600000).toISOString(),
      `Local${index}`,
      `Visitante${index}`,
    )
  );

  const result = formatUpcomingFixtures(matches, now);
  assertStringIncludes(result, "Local24");
  assertEquals(result.includes("Local4"), false);
  assertEquals((result.match(/⚽/g) ?? []).length, 20);
});

Deno.test("escapa nombres HTML y descarta datos incompletos", () => {
  const result = formatUpcomingFixtures([
    fixture("2026-11-20T19:30:00Z", "<Bayern>", "Köln & amigos"),
    fixture("2026-11-21T19:30:00Z", "", "Sin local"),
    fixture("fecha incorrecta"),
  ], now);

  assertStringIncludes(result, "&lt;Bayern&gt;");
  assertStringIncludes(result, "Köln &amp; amigos");
  assertEquals(result.includes("Sin local"), false);
});
