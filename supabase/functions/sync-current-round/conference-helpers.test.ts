import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { openMatchdayTimeToUtc, stableHash } from "./conference-helpers.ts";

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
