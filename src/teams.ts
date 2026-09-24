/**
 * Team 0 (red, the host online) and team 1 (cyan, the CPU). `style.css`
 * repeats these as `--a` and `--b` so the menu paints before any script runs;
 * `teams.test.ts` keeps the two in step.
 *
 * Team red sits well above the foul line's dark matte red (`SURFACE.red`) and
 * leans slightly to crimson, so a weight on or near the line never reads as part of it.
 */
export const TEAM_COLORS = ["#ff4550", "#27d3ff"] as const;

export const TEAM_NAMES = ["RED", "CYAN"] as const;

/** A team colour at `k` of its brightness (sRGB), for the unlit strips on the hall's other boards. */
export function dimColor(css: string, k: number): number {
  const n = parseInt(css.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
