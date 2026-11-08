export type FixtureMatchResult<T> =
  | { status: "unique"; fixture: T }
  | { status: "missing" }
  | { status: "ambiguous" };

export function findUniqueFixtureMatch<T extends { fecha_utc: string }>(
  fixtures: T[],
  commenceTime: string,
  toleranceHours = 12,
): FixtureMatchResult<T> {
  const target = new Date(commenceTime).getTime();
  if (!Number.isFinite(target) || !Number.isFinite(toleranceHours) || toleranceHours < 0) {
    return { status: "missing" };
  }
  const toleranceMs = toleranceHours * 60 * 60 * 1000;
  const matches = fixtures.filter((fixture) => {
    const kickoff = new Date(fixture.fecha_utc).getTime();
    return Number.isFinite(kickoff) && Math.abs(kickoff - target) <= toleranceMs;
  });
  if (matches.length === 0) return { status: "missing" };
  if (matches.length !== 1) return { status: "ambiguous" };
  return { status: "unique", fixture: matches[0] };
}

export function evaluatePredictionOutcome(
  marketKey: string,
  selection: string,
  line: number | null,
  homeScore: number,
  awayScore: number,
): number | null {
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
    return null;
  }
  if (marketKey === "h2h") {
    if (selection === "home") return homeScore > awayScore ? 1 : 0;
    if (selection === "draw") return homeScore === awayScore ? 1 : 0;
    if (selection === "away") return awayScore > homeScore ? 1 : 0;
    return null;
  }
  if (marketKey === "totals" && /^over_\d+(?:\.\d+)?$/.test(selection)) {
    const selectionLine = Number(selection.slice("over_".length));
    const effectiveLine = line ?? selectionLine;
    if (!Number.isFinite(effectiveLine) || effectiveLine < 0 || Math.abs(effectiveLine - selectionLine) > 1e-9) {
      return null;
    }
    return homeScore + awayScore > effectiveLine ? 1 : 0;
  }
  if (marketKey === "btts" && selection === "yes") {
    return homeScore > 0 && awayScore > 0 ? 1 : 0;
  }
  return null;
}
