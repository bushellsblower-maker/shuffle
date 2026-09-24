# SHUFFLE

A phone-first **3D table shuffleboard game** built with Three.js. Pull back, release, and try to hang a weight off the far edge.

This is the game. The SHUFL scorekeeper for real tables lives separately at [shufl.cybush.uk](https://shufl.cybush.uk). Both write finished matches to the same D1 database, so SHUFL's history and this game's scoreboard show the same games.

Live target: **https://shuffle.cybush.uk** (Cloudflare Worker `shuffle`).

## Play

- **Pull back** anywhere on the screen and release to slide the weight. The further you pull, the harder the shot. Drag sideways while pulling to angle it.
- **Pick your lane** by touching down low on the table, near the weight. The weight jumps to that spot before you pull.
- **Flick** forward instead of pulling back if you prefer. Flick speed sets the power.
- The **power meter** on the left shows this shot. The white tick marks your side's last shot.
- The **HEAD** inset on the right is a top-down view of the scoring end, so you can see the far zones while you aim.
- **Ends switch every round.** Both ends of the table are marked. Round 1 shoots from end 0 toward the far wall, round 2 from the far end back, and so on. Between rounds the camera flies out over the hall (other shuffleboards, pool tables) and lands behind the new end.
- **Sand.** The table is dusted with shuffleboard sand. It makes weights glide a touch further and nudges each slide slightly, so two identical flicks won't land in exactly the same spot. Sliding weights plough tracks through the beads, and each round starts with fresh sand.
- Modes: **Pass & play** (two players, one device), **vs CPU**, or **Online** (two devices). Names, target (15 or 21), and mode are saved on the device.
- **Scoreboard** (menu, or the match-over card): wins leaderboard and recent games from the shared SHUFL database.
- **View** (eye button on the menu, before a match): hides the menu and hands you the camera to look round the hall. One finger or a mouse drag orbits, pinch or the wheel zooms, two fingers or a right-drag pans. **MENU** (top right) or Esc goes back. An online match that starts while you are looking round takes the camera back.

## Online play

1. **Host:** Menu → **Online**, enter your name, pick 15 or 21, tap **HOST ONLINE GAME**. You get a 5-character room code (for example `K7QMX`) and a link, `https://shuffle.cybush.uk/join/K7QMX`. Tap the code to copy it, or use **SHARE LINK** / **COPY LINK**.
2. **Guest:** open the link, or Menu → **Online** and type the code under *or join a friend's room*. Enter your name and tap **JOIN**. `?room=K7QMX` works too.
3. The waiting room shows both seats with a live/offline dot. The host taps **START MATCH** once the guest is connected.
4. The host is orange and throws first. Each phone only controls its own weights. The pill under the scorebar says whose turn it is, and you see the opponent's aim and power as they pull back.
5. After each round both players tap **NEXT ROUND**. At the end, **REMATCH** needs both players too, and the loser throws first.

**Disconnects.** The browser reconnects on its own, with backoff, and again as soon as the tab is visible. While either player is offline the match is paused: the room rejects shots and the pill shows *OFFLINE · PAUSED*. A reload or reopened tab rejoins the same seat; the seat token is kept in `localStorage`. If the room has gone, you are returned to the menu with a message.

**Room codes** use `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, which leaves out look-alikes such as 0/O and 1/I/L. That gives about 28 million codes. A room closes after **45 minutes without game activity**, or when a player taps **LEAVE**. Its code can then be reused.

### How the sync works

The room is **authoritative**. There is one Durable Object per room (`Room`, named by the code), and it holds the match state: weights on the table, scores, turn, and round.

- A client sends intents only: `shot {seq, shot: {x, angle, speed}, end}`, `aim` (a cosmetic preview), `ready`, `start`, `leave`.
- The match state carries `end` (which end is shooting this round; it flips in `startNextRound`) and `seed` (the match's sand seed). Both browsers turn the table to the room's `end`, and every shot's sand field is `sandSeed(seed, round, shotIndex)`, known before the throw, so the shooter can still animate without waiting for the network.
- On a `shot`, the room checks the seat, the turn, `seq`, the `end` (if sent), that the opponent is connected, and that the values are ones a real gesture can produce. It then runs the shot to rest with the same solver the browser uses (`src/match.ts` → `src/physics.ts`), applies gutters, falls, and the foul-line sweep, scores the round after the 8th weight, and broadcasts `shot` with the input plus the new room snapshot.
- Both browsers animate the throw locally from the pre-shot table (the shooter's starts right away, without waiting for the network). When the animation settles, each browser snaps the weights to the room's positions and takes turn, scores, and round state from the room. A rejected or lost shot is rewound from the room's snapshot, and a shot lost during a reconnect is re-sent.

The solver uses fixed 240 Hz substeps, so a replay at any frame rate matches the room's result exactly in the same JS engine (tested in `src/online.test.ts`). Across engines the results can differ in the last floating-point bits. The settle step fixes that, so the table never desyncs. The simulation is only a few thousand substeps per shot, so the room can afford it. That is why the room is authoritative rather than trusting the host's browser: no player's device decides where the weights end up.

Wire types are in `src/protocol.ts`. The Durable Object uses the WebSocket Hibernation API, keeps state in Durable Object storage, and replies to `ping` keepalives without waking.

## Scoring

The rules follow SHUFL:

| | |
| --- | --- |
| Weights | 4 per side, alternating shots, 8 shots per round |
| Foul line | A weight has to be completely past the red foul line. Anything short is removed after the shot. |
| Gutter / off the end | Out for the round |
| Ends | Both ends are marked the same. Rounds alternate which end you shoot from, and only the zones at the end you're shooting toward count. |
| Zones | 1, 2, 3, 4 moving toward the far end. A weight touching a line counts the lower zone. |
| Hanger | A weight overhanging the far edge scores **+1 on top of its zone** (a zone-4 hanger is worth 5) |
| Who scores | Only the side with the weight furthest down the table. It scores every one of its weights that is beyond the opponent's best weight. |
| Next round | The side that scored throws first. After a blank round the order stays the same. |
| Winning | The first side to reach the target (15 or 21) at the end of a round wins |

The rules are pure functions in `src/rules.ts`, covered by `src/rules.test.ts`. They work in shooter-relative coordinates (`d` from the shooter's end), so they are the same for both ends; `toTable(end, x, d)` maps onto the physical table.

## Tuning

| Knob | Where | Default | What it does |
| --- | --- | --- | --- |
| `SAND.glide` | `src/physics.ts` | `0.93` | Multiplier on bare-wood friction (`WOOD_FRICTION` 1.55). Lower = slicker table. |
| `SAND.drift` | `src/physics.ts` | `0.09` m/s² | Peak sideways push from lumpy sand. It steers and never adds speed. |
| `SAND.grip` | `src/physics.ts` | `0.045` | ± friction variation between sand patches (changes how far a slide goes). |
| `SAND.cell` | `src/physics.ts` | `0.32` m | Size of a sand patch. |
| `SWAP.duration` | `src/swap.ts` | `3.2` s | Length of the end-swap fly-around. |
| `SWAP.radius` / `SWAP.height` | `src/swap.ts` | `4.6` m / `3.0` m | How wide and how high the camera swings (it stays in the aisle between tables). |
| `SWAP.swing` | `src/swap.ts` | `1.2` rad | How far round to the side of the table the camera goes. |
| `SWAP.houseLights` / `SWAP.fogPush` | `src/swap.ts` | `0.75` / `11` m | House lights up and fog pushed back mid-flight, so the hall reads. |
| `CAMERA.followSmooth` | `src/rig.ts` | `0.3` s | Smooth time of the critically damped spring chasing a sliding weight's look-ahead point. Lower sticks tighter, higher floats. |
| `CAMERA.engage` | `src/rig.ts` | `0.6` s | How long the look-ahead takes to ramp in after the throw, so the camera pulls away from the aim view instead of lurching. |
| `CAMERA.blend.<mode>` | `src/rig.ts` | see file | Switching into a mode eases out the old view over `base + perMetre × distance` seconds (capped at `max`), with no jump in speed or acceleration at either end. `look` scales the look point's time: under 1 turns first (follow), over 1 keeps looking down the table while the camera pulls back (aim). |
| `CAMERA.blendPerSpeed` | `src/rig.ts` | `0.07` s per m/s | Extra blend time when the camera is already moving (a throw during the return), so it turns round gently. |
| `SURFACE.woodLightness` | `src/surface.ts` | `[59, 65]` % | Plank lightness range (hsl) of the playing surface, shared with the hall's other boards. Lower = darker wood, so the sand stands out more. |
| `SURFACE.woodHue` / `SURFACE.woodSaturation` | `src/surface.ts` | `[34, 40]` / `54` % | Plank hue range and saturation. |
| `SURFACE.grainDarken` | `src/surface.ts` | `16` | How many lightness points the grain streaks sit under their plank. |
| `SURFACE.dustAlpha` | `src/surface.ts` | `[0.22, 0.56]` | Opacity range of the sand dust specks painted into the wood. |
| `SURFACE.beadColor` / `SURFACE.beadGlow` | `src/surface.ts` | `#fbf3e0` / `#3a3222` | Albedo and emissive of the 3D sand beads. |
| `SURFACE.ink` / `SURFACE.red` | `src/surface.ts` | `#16161a` / `#b42014` | Zone lines and numbers, and the foul line. `src/surface.test.ts` fails if the wood gets dark enough to hurt their contrast, or if the sand loses its edge over the old surface. |
| `ROAM` | `src/rig.ts` | see file | Free-roam limits: the box the camera and its pivot stay in, zoom range, and how low it can orbit. |

With the defaults, a full-length draw lands within about 2 cm sideways and 3 to 4 cm in length of where it would on perfectly even wax (one standard deviation). `src/rules.test.ts` fails if that spread grows past 4 cm sideways or 7 cm in length. Set `drift` and `grip` to 0 for a perfectly predictable table.

## Shared history (D1)

`wrangler.jsonc` binds SHUFL's existing D1 database `shufl` (`41df98c1-d6bd-479a-b2c9-8f1b8c83966b`) as `DB`. The game reuses SHUFL's `games` table and `leaderboard` view. It creates no new tables. The SQL in `worker/schema.ts` is SHUFL's migration verbatim, and it only runs against an empty database, such as a local `wrangler dev` one.

| Route | |
| --- | --- |
| `GET /api/leaderboard?limit=` | Wins leaderboard (SHUFL's `leaderboard` view) |
| `GET /api/games?limit=` | Recent games from both apps, with `meta` |
| `POST /api/games` | Record a finished **local or CPU** match. The body has the same shape as SHUFL's `POST /api/games` and goes through the same validation (`worker/games.ts`). |

- **Online** matches are written by the room Durable Object when a side wins, so a browser cannot post a fake online result. Row id: `s3d-online-<CODE>-<startedAt>`.
- **Local / CPU** matches are posted by the browser when a winner is declared. Row ids are `s3d-local-…` / `s3d-cpu-…`. Posts that fail offline are queued in `localStorage` and retried on the next load. `POST` is insert-only (`ON CONFLICT DO NOTHING`), so a replayed post cannot overwrite a row.
- Every row has `meta_json = {"source":"shuffle-3d","mode":"online"|"local"|"cpu","order":"scorer-first"}` (plus `room` for online matches). `rounds_json` uses SHUFL's round shape `{n, pts, hangers, totals, hammer}`. `hammer_mode` is `turns`. Shuffle's own order rule (the scorer throws first) is recorded in `meta.order`.

The scoreboard marks each row as `SHUFL` or `3D · ONLINE / CPU / LOCAL`. The shufl repo needs no changes: everything is same-origin on `shuffle.cybush.uk`, so no CORS is involved.

## Run locally

Requires Node 22.12 or newer.

```bash
npm install
npm run dev          # Vite on http://localhost:5173: local and CPU play (no API)
npm test             # rules, ends, sand physics, match engine / sync, camera feel, room codes, history validation
npm run build        # type-check (app + Worker), then write static assets to dist/
```

Online play and the scoreboard need the Worker, which provides the Durable Object and D1:

```bash
npm run dev:worker   # builds dist/, then `wrangler dev` on http://localhost:8787
```

`wrangler dev` runs the Durable Object and a **local** D1 database (under `.wrangler/`) with the schema created on first use, so nothing touches production data. Open `http://localhost:8787` in two browser profiles (or one normal window and one private window) to host and join. Pass `--ip 0.0.0.0` to `wrangler dev` to join from a phone on your LAN.

## How it works

| File | Role |
| --- | --- |
| `src/rules.ts` | Table geometry, zone values, hangers, round scoring, turn order |
| `src/physics.ts` | Custom 2D slide physics: Coulomb friction plus drag, a seeded sand field (glide, drift, grip), weight-to-weight collisions, edge falls. Fixed 240 Hz substeps; `World.drawn` interpolates between the last two so sliding weights move evenly at any frame rate. |
| `src/match.ts` | Pure match engine (shot → rest → sweep → score → next round), shared by the browser and the room |
| `src/protocol.ts`, `src/room-code.ts` | Online message types and parsing; room codes and seat tokens |
| `src/online.ts` | Browser room client: create/join, WebSocket with keepalive, reconnect, and room-gone detection |
| `src/scene.ts` | Three.js scene: maple table marked at both ends, pits at both ends, instanced sand beads that weights plough aside, the hall (a shuffleboard either side, pool tables beyond, baked into a few draw calls), lamps, "Everyday I'm Shuffling" neon, chrome weights, HEAD inset, free-roam controls |
| `src/rig.ts` | Camera rig (pure maths, tested in `src/camera.test.ts`): aim, follow, HEAD, and overview views, blends between them that keep the camera's velocity, the end swap, reflections that turn with the end, and free-roam limits |
| `src/smooth.ts` | Camera maths: a look-ahead target toward where the weight will stop, an exactly solved critically damped spring, a quintic ease-out for blends, and soft clamps at the far end |
| `src/swap.ts` | End-swap camera path between rounds (pure maths, tested in `src/camera.test.ts`) |
| `src/textures.ts` | Canvas-generated textures (table, matte zone markings, concrete, aim arrow). No image assets. |
| `src/main.ts` | Match and round state machine, online settle and resync, pull-back and flick input, fall animations, HUD, menu, waiting room |
| `src/scoreboard.ts`, `src/history.ts` | Scoreboard panel; SHUFL-shaped game records |
| `src/ai.ts` | CPU opponent. It either draws to the 3 or 4 zone or knocks off your leading weight, with some aim and power noise. |
| `src/audio.ts` | Synthesized WebAudio effects, with nothing loaded from the network. The slide rumble runs straight to the output. Hits (inharmonic metal partials plus a click), launch thump, gutter drop and rattle, score bell chord, blank-round mallet, brass win fanfare, and UI clicks go through a compressor and a synthesized room reverb. |
| `worker/index.ts` | Worker entry: `/api/rooms…` (create, info, join, WebSocket) and `/api/games`, `/api/leaderboard`. Everything else is static assets. |
| `worker/room.ts` | `Room` Durable Object: seats and tokens, authoritative match, idle expiry alarm, D1 write on match end |
| `worker/api.ts`, `worker/games.ts`, `worker/schema.ts` | History API, SHUFL-compatible validation, schema bootstrap for empty local D1 |

The physics is a custom solver rather than a rigid-body engine. A shuffleboard weight only slides in 2D, and a small deterministic solver is easier to tune for a fair feel. The same solver plans the CPU's shots and runs online rooms.

## Deploy to shuffle.cybush.uk

Publishing is **GitHub → Cloudflare** only. `wrangler.jsonc` defines the Worker `shuffle` (`worker/index.ts`), with:

- static assets from `dist/`, SPA fallback on, and only `/api/*` routed to the Worker first
- Durable Object class `Room` bound as `ROOMS` (migration `v1`, SQLite-backed, available on the Workers Free plan)
- D1 `shufl` bound as `DB`, using its existing `database_id`
- custom domain `shuffle.cybush.uk`

No secrets are committed.

**First deploy after this change:** `wrangler deploy` registers the `Room` class from the `v1` migration and attaches the D1 binding. The Cloudflare account that deploys must be the one that owns the `shufl` D1 database. No schema change or D1 migration is needed. Later deploys reuse both.

### Option A: GitHub Actions (`.github/workflows/deploy.yml`)

Runs on every push to `main`, or from **Actions → Publish to Cloudflare**. It installs dependencies, runs the tests, then runs `npm run deploy` (build, then `wrangler deploy`).

Add these repository secrets on **bushellsblower-maker/shuffle** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token that can edit Workers scripts, Workers routes / custom domains on zone `cybush.uk`, and **D1** (to bind `shufl`) |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that owns `cybush.uk` and the `shufl` D1 database |

Secrets are per repository, so the values on shufl or Adonis are not visible here. Until both exist, the publish workflow fails with a message saying what to add. The **Check** workflow (type-check, tests, build, `wrangler deploy --dry-run`) needs no secrets.

### Option B: Cloudflare Workers Builds

1. Workers & Pages → Create → Import a repository → `bushellsblower-maker/shuffle`
2. Production branch: `main`
3. Build command: `npm run build`
4. Deploy command: `npx wrangler deploy`

Workers Builds uses the connected Cloudflare account, so no GitHub secrets are needed for this path. Use one option or the other. Running both would publish twice.

A successful deploy creates Worker `shuffle` and attaches `shuffle.cybush.uk`. Zone `cybush.uk` must already be on that account.

### Dependency pinning

`package.json` pins exact versions and `package-lock.json` is committed. CI still runs `npm install`. Switch the workflows to `npm ci` if you want strict lockfile installs.
