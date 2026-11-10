import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { conferenceFixtureHash, conferenceHistoricalId, conferenceNamespacedId, openMatchdayTimeToUtc, stableHash } from "./conference-helpers.ts";

Deno.test("aplica el offset fijo UTC+1 de Open-matchday", () => {
  assertEquals(openMatchdayTimeToUtc("2026-11-26", "16:30"), "2026-11-26T15:30:00.000Z");
});

Deno.test("mantiene el offset fijo UTC+1 de Open-matchday en fechas de verano", () => {
  assertEquals(openMatchdayTimeToUtc("2027-06-10", "16:30"), "2027-06-10T15:30:00.000Z");
});

Deno.test("valida formato de fecha y hora", () => {
  let rejected = false;
  try { openMatchdayTimeToUtc("2027-03-28", "25:30"); } catch { rejected = true; }
  assertEquals(rejected, true);
});

Deno.test("hash normaliza acentos y distingue nombres diferentes", () => {
  assertEquals(stableHash("team|Mjällby"), stableHash("team|Mjallby"));
  assertNotEquals(stableHash("team|Ajax"), stableHash("team|Thun"));
  assertEquals(Number.isSafeInteger(8_000_000_000_000_000 + stableHash("match|x")), true);
});

Deno.test("ID de partido distingue enfrentamientos repetidos en fechas distintas", () => {
  const first = conferenceFixtureHash("2026/27", "2026-12-01", "Club A", "Club B");
  const second = conferenceFixtureHash("2026/27", "2027-02-01", "Club A", "Club B");
  assertEquals(first, conferenceFixtureHash("2026/27", "2026-12-01", "Club A", "Club B"));
  assertNotEquals(first, second);
});

Deno.test("IDs internos de Conference no se solapan con IDs originales de API-Football", () => {
  const matchId = conferenceNamespacedId(8_000_000_000_000_000, stableHash("match|x"));
  const teamId = conferenceNamespacedId(7_000_000_000_000_000, stableHash("team|x"));
  assertEquals(matchId > 8_000_000_000_000_000 + 1_000_000_000, true);
  assertEquals(teamId > 7_000_000_000_000_000 + 1_000_000_000, true);
  assertEquals(Number.isSafeInteger(matchId), true);
  assertEquals(Number.isSafeInteger(teamId), true);
  assertEquals(Number.isSafeInteger(conferenceNamespacedId(8_000_000_000_000_000, (1n << 48n) - 1n as unknown as number)), true);
});

Deno.test("ID histórico es determinista y queda fuera del rango antiguo", () => {
  const id = conferenceHistoricalId("2021/22", "2021-09-16", "Club A", "Club B");
  assertEquals(id, conferenceHistoricalId("2021/22", "2021-09-16", "Club A", "Club B"));
  assertEquals(id > 4415 && Number.isSafeInteger(id), true);
});
