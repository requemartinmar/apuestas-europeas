import {
  evaluatePredictionOutcome,
  findUniqueFixtureMatch,
} from "./settlement.ts";

Deno.test("1X2: local gana y selección local acierta", () => {
  if (evaluatePredictionOutcome("h2h", "home", null, 2, 0) !== 1) throw new Error("Expected win");
});
Deno.test("1X2: local no gana y selección local falla", () => {
  if (evaluatePredictionOutcome("h2h", "home", null, 1, 1) !== 0) throw new Error("Expected loss");
});
Deno.test("1X2: empate acierta y no empate falla", () => {
  if (evaluatePredictionOutcome("h2h", "draw", null, 0, 0) !== 1) throw new Error("Expected draw win");
  if (evaluatePredictionOutcome("h2h", "draw", null, 2, 1) !== 0) throw new Error("Expected draw loss");
});
Deno.test("1X2: visitante gana y selección visitante acierta", () => {
  if (evaluatePredictionOutcome("h2h", "away", null, 0, 1) !== 1) throw new Error("Expected away win");
});
Deno.test("1X2: visitante no gana y selección visitante falla", () => {
  if (evaluatePredictionOutcome("h2h", "away", null, 1, 0) !== 0) throw new Error("Expected away loss");
});
Deno.test("Over 2.5: tres goles gana y dos goles pierde", () => {
  if (evaluatePredictionOutcome("totals", "over_2.5", 2.5, 2, 1) !== 1) throw new Error("Expected over win");
  if (evaluatePredictionOutcome("totals", "over_2.5", 2.5, 1, 1) !== 0) throw new Error("Expected over loss");
});
Deno.test("Over respeta línea distinta", () => {
  if (evaluatePredictionOutcome("totals", "over_1.5", 1.5, 1, 1) !== 1) throw new Error("Expected over 1.5 win");
  if (evaluatePredictionOutcome("totals", "over_2.5", 1.5, 2, 1) !== null) throw new Error("Mismatched line must be unsupported");
});
Deno.test("BTTS sí: ambos marcan / uno no marca", () => {
  if (evaluatePredictionOutcome("btts", "yes", null, 1, 1) !== 1) throw new Error("Expected BTTS win");
  if (evaluatePredictionOutcome("btts", "yes", null, 0, 2) !== 0) throw new Error("Expected BTTS loss");
});
Deno.test("mercado no soportado o marcador inválido queda sin liquidar", () => {
  if (evaluatePredictionOutcome("btts", "no", null, 1, 1) !== null) throw new Error("Unsupported selection");
  if (evaluatePredictionOutcome("h2h", "home", null, -1, 0) !== null) throw new Error("Invalid score");
});
Deno.test("matching: único partido dentro de tolerancia", () => {
  const result = findUniqueFixtureMatch([{ id: 1, fecha_utc: "2026-11-08T18:00:00Z" }], "2026-11-08T20:00:00Z");
  if (result.status !== "unique" || result.fixture.id !== 1) throw new Error("Expected unique match");
});
Deno.test("matching: fuera de tolerancia no empareja", () => {
  const result = findUniqueFixtureMatch([{ id: 1, fecha_utc: "2026-11-08T07:59:59Z" }], "2026-11-08T20:00:00Z");
  if (result.status !== "missing") throw new Error("Expected missing");
});
Deno.test("matching: dos candidatos dentro de tolerancia son ambiguos", () => {
  const result = findUniqueFixtureMatch([
    { id: 1, fecha_utc: "2026-11-08T18:00:00Z" },
    { id: 2, fecha_utc: "2026-11-08T19:00:00Z" },
  ], "2026-11-08T18:30:00Z");
  if (result.status !== "ambiguous") throw new Error("Expected ambiguous");
});
