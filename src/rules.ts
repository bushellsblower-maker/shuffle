/**
 * Table geometry and SHUFL-style scoring. Distances are metres measured down
 * the table from the shooter's end (`d`), with `x` across the table (0 = centre).
 */
export const TABLE = {
  length: 7.2,
  width: 0.9,
  puckRadius: 0.055,
  puckHeight: 0.042,
  launchD: 0.5,
  foul: 4.6,
  /** Start of zones 1..4 (trailing edge of a weight must be past the line). */
  zones: [4.6, 5.6, 6.35, 6.9] as const,
  weightsPerSide: 4,
} as const;

export type Team = 0 | 1;

/**
 * Which end of the table the shooters stand at. The board is marked the same
 * at both ends; end 0 shoots toward the far wall, end 1 back toward end 0.
 * Every rule and the physics work in shooter-relative (`x`, `d`); only the
 * scene and the sand field need absolute table coordinates.
 */
export type End = 0 | 1;

/** Rounds alternate ends, like walking to the other end of a real table. */
export function endForRound(round: number): End {
  return (Math.max(0, Math.floor(round) - 1) % 2) as End;
}

/**
 * Shooter-relative → absolute table coordinates (end 0's frame). The map is a
 * half turn about the table centre, so it is its own inverse.
 */
export function toTable(end: End, x: number, d: number): { x: number; d: number } {
  return end === 0 ? { x, d } : { x: -x, d: TABLE.length - d };
}

export interface RestingWeight {
  team: Team;
  x: number;
  d: number;
}

export interface CountedWeight {
  index: number;
  zone: number;
  hanger: boolean;
  value: number;
}

export interface RoundResult {
  team: Team | null;
  points: number;
  counted: CountedWeight[];
}

export function onTable(x: number, d: number): boolean {
  return Math.abs(x) <= TABLE.width / 2 && d >= 0 && d <= TABLE.length;
}

/** A weight is live only once it is completely past the foul line. */
export function isLive(w: { x: number; d: number }): boolean {
  return onTable(w.x, w.d) && w.d - TABLE.puckRadius > TABLE.foul;
}

/** Overhangs the far edge but its centre is still on the table. */
export function isHanger(d: number): boolean {
  return d <= TABLE.length && d + TABLE.puckRadius > TABLE.length;
}

/** Touching a line counts as the lower zone, so use the trailing edge. */
export function zoneOf(d: number): number {
  const trailing = d - TABLE.puckRadius;
  for (let i = TABLE.zones.length - 1; i >= 0; i--) {
    if (trailing >= TABLE.zones[i]) return i + 1;
  }
  return 0;
}

export function weightValue(d: number): { zone: number; hanger: boolean; value: number } {
  const zone = zoneOf(d);
  const hanger = zone > 0 && isHanger(d);
  return { zone, hanger, value: zone + (hanger ? 1 : 0) };
}

/**
 * Only the side with the weight furthest down the table scores. It scores
 * every one of its weights that is further than the opponent's best weight.
 */
export function scoreRound(weights: readonly RestingWeight[]): RoundResult {
  const best: [number, number] = [-Infinity, -Infinity];
  weights.forEach((w) => {
    if (isLive(w)) best[w.team] = Math.max(best[w.team], w.d);
  });
  if (best[0] === best[1]) return { team: null, points: 0, counted: [] };
  const team: Team = best[0] > best[1] ? 0 : 1;
  const beat = best[team === 0 ? 1 : 0];
  const counted: CountedWeight[] = [];
  weights.forEach((w, index) => {
    if (w.team !== team || !isLive(w) || w.d <= beat) return;
    counted.push({ index, ...weightValue(w.d) });
  });
  counted.sort((a, b) => b.value - a.value);
  const points = counted.reduce((sum, c) => sum + c.value, 0);
  return { team, points, counted };
}

/** The side that scored throws first next round; after a blank round the order stays. */
export function nextFirstShooter(previousFirst: Team, result: RoundResult): Team {
  return result.team ?? previousFirst;
}

export function shooterFor(firstShooter: Team, shotIndex: number): Team {
  return (shotIndex % 2 === 0 ? firstShooter : 1 - firstShooter) as Team;
}

export function matchWinner(scores: readonly [number, number], target: number): Team | null {
  if (scores[0] >= target && scores[0] > scores[1]) return 0;
  if (scores[1] >= target && scores[1] > scores[0]) return 1;
  return null;
}
