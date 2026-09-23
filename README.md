# SHUFFLE

A phone-first **3D table shuffleboard game** built with Three.js. Pull back, release, and try to hang a weight off the far edge.

This is the game. The SHUFL scorekeeper for real tables lives separately at [shufl.cybush.uk](https://shufl.cybush.uk).

Live target: **https://shuffle.cybush.uk** (Cloudflare Worker `shuffle`).

## Play

- **Pull back** anywhere on the screen and release to slide the weight. The further you pull, the harder the shot. Drag sideways while pulling to angle it.
- **Pick your lane** by touching down low on the table, near the weight. The weight jumps to that spot before you pull.
- **Flick** forward instead of pulling back if you prefer. Flick speed sets the power.
- The **power meter** on the left shows this shot. The white tick marks your side's last shot.
- The **HEAD** inset on the right is a top-down view of the scoring end, so you can see the far zones while you aim.
- Modes: **2 players** (pass and play) or **vs CPU**. Names, target (15 or 21), and mode are saved on the device.

## Scoring

The rules follow SHUFL:

| | |
| --- | --- |
| Weights | 4 per side, alternating shots, 8 shots per round |
| Foul line | A weight has to be completely past the red foul line. Anything short is removed after the shot. |
| Gutter / off the end | Out for the round |
| Zones | 1, 2, 3, 4 moving toward the far end. A weight touching a line counts the lower zone. |
| Hanger | A weight overhanging the far edge scores **+1 on top of its zone** (a zone-4 hanger is worth 5) |
| Who scores | Only the side with the weight furthest down the table. It scores every one of its weights that is beyond the opponent's best weight. |
| Next round | The side that scored throws first. After a blank round the order stays the same. |
| Winning | The first side to reach the target (15 or 21) at the end of a round wins |

The rules are pure functions in `src/rules.ts`, covered by `src/rules.test.ts`.

## Run locally

Requires Node 22.12 or newer.

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN, for testing on a phone)
npm test           # rules + physics tests
npm run build      # type-check, then write static assets to dist/
npm run preview    # serve dist/
```

## How it works

| File | Role |
| --- | --- |
| `src/rules.ts` | Table geometry, zone values, hangers, round scoring, turn order |
| `src/physics.ts` | Custom 2D slide physics: Coulomb friction plus drag, weight-to-weight collisions, edge falls. Fixed 240 Hz substeps. |
| `src/scene.ts` | Three.js scene: maple table with painted zones, gutters, end pit, lamps, neon, chrome weights, camera rig, HEAD inset |
| `src/textures.ts` | Canvas-generated textures (table, concrete, aim arrow). No image assets. |
| `src/main.ts` | Match and round state machine, pull-back and flick input, fall animations, HUD |
| `src/ai.ts` | CPU opponent. It either draws to the 3 or 4 zone or knocks off your leading weight, with some aim and power noise. |
| `src/audio.ts` | Synthesized WebAudio effects (slide, clack, drop, chimes) |

The physics is a custom solver rather than a rigid-body engine. A shuffleboard weight only slides in 2D, and a small deterministic solver is easier to tune for a fair feel. The same solver plans the CPU's shots.

## Deploy to shuffle.cybush.uk

Publishing is **GitHub → Cloudflare** only. `wrangler.jsonc` defines an assets-only Worker named `shuffle` that serves `dist/`, with custom domain `shuffle.cybush.uk`. No secrets are committed.

### Option A: GitHub Actions (`.github/workflows/deploy.yml`)

Runs on every push to `main`, or from **Actions → Publish to Cloudflare**. It installs dependencies, runs the tests, then runs `npm run deploy` (build, then `wrangler deploy`).

Add these repository secrets on **bushellsblower-maker/shuffle** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token that can edit Workers scripts and Workers routes / custom domains on zone `cybush.uk` |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that owns `cybush.uk` |

Secrets are per repository, so the values on shufl or Adonis are not visible here. Until both exist, the publish workflow fails with a message saying what to add. The **Check** workflow (type-check, tests, build, `wrangler deploy --dry-run`) needs no secrets.

### Option B: Cloudflare Workers Builds

1. Workers & Pages → Create → Import a repository → `bushellsblower-maker/shuffle`
2. Production branch: `main`
3. Build command: `npm run build`
4. Deploy command: `npx wrangler deploy`

Workers Builds uses the connected Cloudflare account, so no GitHub secrets are needed for this path. Use one option or the other. Running both would publish twice.

A successful deploy creates Worker `shuffle` and attaches `shuffle.cybush.uk`. Zone `cybush.uk` must already be on that account.

If a D1 database is added later, leave `database_id` out of `wrangler.jsonc`. `wrangler deploy` in Workers Builds provisions the database and binds it.

### Dependency pinning

`package.json` pins exact versions. There is no `package-lock.json` yet, so CI uses `npm install`. To lock the full tree, run `npm install` locally, commit `package-lock.json`, and switch the workflows to `npm ci`.
