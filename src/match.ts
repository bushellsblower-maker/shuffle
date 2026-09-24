/**
 * Pure match engine shared by the browser and the online room Durable Object.
 * The room runs every shot through `throwShot` and is the source of truth; the
 * browser replays the same shot with the same solver for the animation, then
 * settles onto the room's resting positions.
 */
import { MAX_ANGLE, MIN_SPEED } from "./ai.ts";
import { MAX_SPEED, World, sandSeed, type Body } from "./physics.ts";
import {
  TABLE,
  endForRound,
  isLive,
  matchWinner,
  nextFirstShooter,
  scoreRound,
  shooterFor,
  type End,
  type RoundResult,
  type Team,
} from "./rules.ts";

export const LANE = TABLE.width / 2 - TABLE.puckRadius - 0.02;
export const SHOTS_PER_ROUND = TABLE.weightsPerSide * 2;
/** Simulated seconds after which a shot is force-stopped (a lone max-power slide takes ~4s). */
const MAX_SIM_SECONDS = 30;
const SIM_DT = 1 / 60;

export interface ShotInput {
  x: number;
  angle: number;
  speed: number;
}

/** A weight resting in play. `id` is the shot index within the round that threw it. */
export interface TableWeight {
  id: number;
  team: Team;
  x: number;
  d: number;
}

/** Same shape SHUFL stores in `rounds_json`. `hammer` is the side that throws last. */
export interface RoundLog {
  n: number;
  pts: [number, number];
  hangers: [number, number];
  totals: [number, number];
  hammer: Team;
}

export type MatchPhase = "aim" | "roundEnd" | "matchEnd";

export interface MatchState {
  target: number;
  scores: [number, number];
  round: number;
  /** End the shooters stand at this round; flips every round (`endForRound`). */
  end: End;
  /** Per-match sand seed; each shot's sand field is `sandSeed(seed, round, shotIndex)`. */
  seed: number;
  firstShooter: Team;
  shotIndex: number;
  /** Live weights at rest, in throw order (the solver's collision order depends on it). */
  table: TableWeight[];
  phase: MatchPhase;
  last: RoundResult | null;
  winner: Team | null;
  rounds: RoundLog[];
  startedAt: number;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

export function newMatchState(target: number, firstShooter: Team = 0, now = Date.now(), seed = randomSeed()): MatchState {
  return {
    target,
    scores: [0, 0],
    round: 1,
    end: endForRound(1),
    seed,
    firstShooter,
    shotIndex: 0,
    table: [],
    phase: "aim",
    last: null,
    winner: null,
    rounds: [],
    startedAt: now,
  };
}

export function shooterOf(s: MatchState): Team | null {
  return s.phase === "aim" ? shooterFor(s.firstShooter, s.shotIndex) : null;
}

/** Fill in fields a room saved by an older build may lack. */
export function upgradeMatch(s: MatchState): MatchState {
  if (s.end !== 0 && s.end !== 1) s.end = endForRound(s.round);
  if (typeof s.seed !== "number" || !Number.isFinite(s.seed)) s.seed = 0;
  return s;
}

/** Sand seed for the next shot of this match. */
export function nextShotSand(s: MatchState): number {
  return sandSeed(s.seed, s.round, s.shotIndex);
}

/** Weights each side still has to throw this round. */
export function weightsLeft(s: MatchState, team: Team): number {
  let thrown = 0;
  for (let i = 0; i < s.shotIndex; i++) if (shooterFor(s.firstShooter, i) === team) thrown++;
  return TABLE.weightsPerSide - thrown;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Accept a shot from the network. Values a real gesture can produce pass through unchanged. */
export function parseShot(v: unknown): ShotInput | null {
  if (!v || typeof v !== "object") return null;
  const { x, angle, speed } = v as Record<string, unknown>;
  if (!finite(x) || !finite(angle) || !finite(speed)) return null;
  const eps = 1e-6;
  if (Math.abs(x) > LANE + eps || Math.abs(angle) > MAX_ANGLE + eps) return null;
  if (speed < MIN_SPEED - eps || speed > MAX_SPEED + eps) return null;
  return { x, angle, speed };
}

export function launchBody(shot: ShotInput): Body {
  return {
    x: shot.x,
    d: TABLE.launchD,
    vx: shot.speed * Math.sin(shot.angle),
    vd: shot.speed * Math.cos(shot.angle),
    active: true,
  };
}

/**
 * Run one shot to rest on the sand field `sand` (null for even wax). Returns
 * the weights still in play after gutters, falls, and the foul-line sweep.
 */
export function simulateShot(table: readonly TableWeight[], shot: ShotInput, id: number, team: Team, sand: number | null = null): TableWeight[] {
  const bodies: Body[] = table.map((w) => ({ x: w.x, d: w.d, vx: 0, vd: 0, active: true }));
  bodies.push(launchBody(shot));
  const world = new World(bodies, sand);
  const meta = [...table.map((w) => ({ id: w.id, team: w.team })), { id, team }];
  for (let t = 0; t < MAX_SIM_SECONDS && world.moving; t += SIM_DT) world.step(SIM_DT);
  const out: TableWeight[] = [];
  bodies.forEach((b, i) => {
    if (b.active && isLive(b)) out.push({ id: meta[i].id, team: meta[i].team, x: b.x, d: b.d });
  });
  return out;
}

export function roundLog(n: number, result: RoundResult, totals: readonly [number, number], firstShooter: Team): RoundLog {
  const pts: [number, number] = [0, 0];
  const hangers: [number, number] = [0, 0];
  if (result.team !== null) {
    pts[result.team] = result.points;
    hangers[result.team] = result.counted.filter((c) => c.hanger).length;
  }
  return { n, pts, hangers, totals: [totals[0], totals[1]], hammer: (1 - firstShooter) as Team };
}

function finishRound(s: MatchState): void {
  const result = scoreRound(s.table);
  if (result.team !== null) s.scores[result.team] += result.points;
  s.last = result;
  s.rounds.push(roundLog(s.round, result, s.scores, s.firstShooter));
  s.winner = matchWinner(s.scores, s.target);
  s.phase = s.winner === null ? "roundEnd" : "matchEnd";
}

/**
 * Apply a shot for `team`, thrown from `end` if the client said which. Mutates
 * `s`; returns an error message if the shot is not allowed.
 */
export function throwShot(s: MatchState, team: Team, shot: ShotInput, end?: End): string | null {
  if (s.phase !== "aim") return "The round is over";
  if (shooterOf(s) !== team) return "Not your turn";
  if (end !== undefined && end !== s.end) return "Out of sync";
  s.table = simulateShot(s.table, shot, s.shotIndex, team, nextShotSand(s));
  s.shotIndex++;
  if (s.shotIndex >= SHOTS_PER_ROUND) finishRound(s);
  return null;
}

export function startNextRound(s: MatchState): string | null {
  if (s.phase !== "roundEnd" || !s.last) return "No round to advance";
  s.firstShooter = nextFirstShooter(s.firstShooter, s.last);
  s.round++;
  s.end = endForRound(s.round);
  s.shotIndex = 0;
  s.table = [];
  s.last = null;
  s.phase = "aim";
  return null;
}
