import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { madridLocalTimeToUtc, stableHash } from "./conference-helpers.ts";

Deno.test("convierte horario de invierno de Madrid a UTC", () => {
  assertEquals(madridLocalTimeToUtc("2026-11-26", "16:30"), "2026-11-26T15:30:00.000Z");
});

Deno.test("convierte horario de verano de Madrid a UTC", () => {
  assertEquals(madridLocalTimeToUtc("2027-06-10", "16:30"), "2027-06-10T14:30:00.000Z");
});

Deno.test("rechaza una hora inexistente durante el salto de primavera", () => {
  let rejected = false;
  try { madridLocalTimeToUtc("2027-03-28", "02:30"); } catch { rejected = true; }
  assertEquals(rejected, true);
});

Deno.test("hash normaliza acentos y distingue nombres diferentes", () => {
  assertEquals(stableHash("team|Mjällby"), stableHash("team|Mjallby"));
  assertNotEquals(stableHash("team|Ajax"), stableHash("team|Thun"));
  assertEquals(Number.isSafeInteger(8_000_000_000_000_000 + stableHash("match|x")), true);
});
