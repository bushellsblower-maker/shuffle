import "./style.css";
import { MAX_ANGLE, planCpuShot, powerOf, speedOf, type Shot } from "./ai.ts";
import { Sound } from "./audio.ts";
import { World, type Body } from "./physics.ts";
import {
  TABLE,
  isLive,
  matchWinner,
  nextFirstShooter,
  scoreRound,
  shooterFor,
  type RoundResult,
  type Team,
} from "./rules.ts";
import { GUTTER_W, GUTTER_Y, PIT_LEN, Stage, TEAM_COLORS, type PuckView } from "./scene.ts";

type Mode = "2p" | "cpu";
interface Settings {
  names: [string, string];
  target: 15 | 21;
  mode: Mode;
}

interface Fall {
  x: number;
  y: number;
  d: number;
  vx: number;
  vy: number;
  vd: number;
  floor: number;
  tilt: number;
  landed: boolean;
}

interface Weight {
  team: Team;
  view: PuckView;
  body: Body | null;
  status: "rack" | "aim" | "play" | "falling" | "gone";
  fall?: Fall;
}

type Phase = "menu" | "aim" | "rolling" | "resolving" | "roundEnd" | "matchEnd";

const R = TABLE.puckRadius;
const LANE = TABLE.width / 2 - R - 0.02;
const CPU: Team = 1;
const DEFAULT_NAMES: [string, string] = ["ORANGE", "CYAN"];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("c");
const stage = new Stage(canvas);
const sound = new Sound();
const world = new World();

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem("shuffle.settings") ?? "") as Partial<Settings>;
    return {
      names: [s.names?.[0] || DEFAULT_NAMES[0], s.names?.[1] || DEFAULT_NAMES[1]],
      target: s.target === 15 ? 15 : 21,
      mode: s.mode === "cpu" ? "cpu" : "2p",
    };
  } catch {
    return { names: [...DEFAULT_NAMES], target: 21, mode: "2p" };
  }
}

let settings = loadSettings();
let phase: Phase = "menu";
let matchLive = false;
let scores: [number, number] = [0, 0];
let round = 1;
let firstShooter: Team = 0;
let shotIndex = 0;
let weights: Weight[] = [];
let current: Weight | null = null;
let resolveTimer = 0;
let lastResult: RoundResult | null = null;
const lastPower: [number | null, number | null] = [null, null];
const lastX: [number, number] = [0, 0];
let labels: { el: HTMLElement; w: Weight }[] = [];
let cpu: { shot: Shot; t: number; fromX: number } | null = null;

const isCpuTurn = () => settings.mode === "cpu" && current?.team === CPU;
const teamName = (t: Team) => settings.names[t];

/* ---------------- HUD ---------------- */

const hud = {
  team: [$("team0"), $("team1")],
  round: $("round"),
  target: $("target"),
  banner: $("banner"),
  hint: $("hint"),
  power: $("power"),
  powerFill: document.querySelector<HTMLElement>("#power .fill")!,
  powerLast: document.querySelector<HTMLElement>("#power .last")!,
  inset: $("inset"),
  labels: $("labels"),
  card: $("roundCard"),
  menu: $("menu"),
};

function renderHud(): void {
  ([0, 1] as Team[]).forEach((t) => {
    const el = hud.team[t];
    const cpuTag = settings.mode === "cpu" && t === CPU && teamName(t) !== "CPU" ? " · CPU" : "";
    el.querySelector(".name")!.textContent = teamName(t) + cpuTag;
    el.querySelector(".score")!.textContent = String(scores[t]);
    el.classList.toggle("active", !!current && current.team === t && (phase === "aim" || phase === "rolling"));
    const pips = el.querySelector(".pips")!;
    const mine = weights.filter((w) => w.team === t);
    pips.innerHTML = mine
      .map((w) => `<i class="${w.status === "rack" ? "full" : w.status === "aim" ? "now" : ""}"></i>`)
      .join("");
  });
  hud.round.textContent = String(round);
  hud.target.textContent = String(settings.target);
}

let bannerTimer = 0;
function banner(text: string, team: Team | null = null, seconds = 1.6): void {
  hud.banner.textContent = text;
  hud.banner.style.setProperty("--c", team === null ? "#ffc21a" : TEAM_COLORS[team]);
  hud.banner.classList.remove("show");
  void hud.banner.offsetWidth;
  hud.banner.classList.add("show");
  bannerTimer = seconds;
}

function setPower(p: number | null): void {
  hud.power.classList.toggle("on", p !== null);
  if (p !== null) hud.powerFill.style.height = `${Math.round(p * 100)}%`;
  const last = current ? lastPower[current.team] : null;
  hud.powerLast.style.display = last === null ? "none" : "block";
  if (last !== null) hud.powerLast.style.bottom = `${last * 100}%`;
  if (current) hud.power.style.setProperty("--c", TEAM_COLORS[current.team]);
}

function layout(): void {
  stage.resize();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const portrait = w / h < 0.8;
  const iw = Math.round(portrait ? Math.min(Math.max(w * 0.2, 70), 112) : Math.min(140, w * 0.14));
  const ih = Math.round(Math.min(iw * 2.7, h * 0.55));
  const top = (document.querySelector(".bar") as HTMLElement).getBoundingClientRect().bottom + 10;
  const rect = { x: w - iw - 10, y: Math.round(top), w: iw, h: ih };
  stage.inset = rect;
  Object.assign(hud.inset.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
}

/* ---------------- Match flow ---------------- */

function clearWeights(): void {
  weights.forEach((w) => stage.removePuck(w.view));
  weights = [];
  world.bodies = [];
  labels.forEach((l) => l.el.remove());
  labels = [];
}

function rackPosition(w: Weight): void {
  const idx = weights.filter((o) => o.team === w.team && o.status === "rack").indexOf(w);
  const s = w.team === 0 ? -1 : 1;
  w.view.group.position.set(s * (0.62 - idx * 0.125), -0.03, 0.12);
  w.view.group.rotation.set(0, 0, 0);
}

function newMatch(): void {
  scores = [0, 0];
  round = 1;
  firstShooter = 0;
  lastPower[0] = lastPower[1] = null;
  matchLive = true;
  hideCard();
  startRound();
}

function startRound(): void {
  clearWeights();
  lastResult = null;
  shotIndex = 0;
  for (let i = 0; i < TABLE.weightsPerSide; i++) {
    for (const team of [0, 1] as Team[]) {
      weights.push({ team, view: stage.createPuck(team), body: null, status: "rack" });
    }
  }
  weights.forEach(rackPosition);
  banner(`ROUND ${round}`, null, 1.3);
  nextTurn();
}

function nextTurn(): void {
  const team = shooterFor(firstShooter, shotIndex);
  current = weights.find((w) => w.team === team && w.status === "rack") ?? null;
  if (!current) return endRound();
  current.status = "aim";
  weights.filter((w) => w.status === "rack").forEach(rackPosition);
  placeAim(lastX[team]);
  phase = "aim";
  stage.setCamera("aim");
  stage.hideAim();
  const left = TABLE.weightsPerSide - Math.floor(shotIndex / 2);
  setTimeout(() => {
    if (phase === "aim") banner(`${teamName(team)} · ${left} LEFT`, team, 1.4);
  }, shotIndex === 0 ? 1100 : 0);
  hud.hint.textContent = isCpuTurn() ? "CPU is lining up…" : "Pull back & release · or flick forward";
  hud.hint.classList.add("show");
  setPower(null);
  if (isCpuTurn()) {
    const resting = weights.filter((w) => w.status === "play" && w.body).map((w) => ({ team: w.team, x: w.body!.x, d: w.body!.d }));
    cpu = { shot: planCpuShot(resting, CPU), t: -0.6, fromX: lastX[team] };
  } else cpu = null;
  renderHud();
}

function placeAim(x: number, pull = 0): void {
  if (!current) return;
  current.view.group.position.set(x, 0, -(TABLE.launchD - pull));
  current.view.group.rotation.set(0, 0, 0);
}

function launch(x: number, angle: number, speed: number): void {
  if (!current || phase !== "aim") return;
  const w = current;
  lastX[w.team] = x;
  lastPower[w.team] = powerOf(speed);
  w.body = { x, d: TABLE.launchD, vx: speed * Math.sin(angle), vd: speed * Math.cos(angle), active: true };
  world.bodies.push(w.body);
  w.status = "play";
  phase = "rolling";
  resolveTimer = 0;
  stage.hideAim();
  stage.setCamera("follow", TABLE.launchD);
  hud.hint.classList.remove("show");
  setPower(null);
  sound.launch(powerOf(speed));
  renderHud();
}

function startFall(w: Weight, edge: "side" | "end" | "near" | "sweep"): void {
  const b = w.body!;
  b.active = false;
  const side = Math.sign(b.x) || 1;
  const fall: Fall = { x: b.x, y: 0, d: b.d, vx: b.vx, vy: 0, vd: b.vd, floor: GUTTER_Y, tilt: 0, landed: false };
  if (edge === "sweep") {
    fall.vx = side * 1.6;
    fall.vy = 0.9;
    fall.vd = 0;
  }
  if (edge === "near") fall.floor = -0.035;
  w.fall = fall;
  w.status = "falling";
}

function stepFalls(dt: number): boolean {
  let busy = false;
  const maxX = TABLE.width / 2 + GUTTER_W - R - 0.005;
  for (const w of weights) {
    const f = w.fall;
    if (w.status !== "falling" || !f) continue;
    busy = true;
    const overSide = Math.abs(f.x) > TABLE.width / 2;
    const overEnd = f.d > TABLE.length || f.d < 0;
    if (!f.landed) {
      f.vy -= 9.8 * dt;
      f.y += f.vy * dt;
      if (!overSide && !overEnd && f.y < 0) {
        f.y = 0;
        f.vy = 0;
      }
      if (f.y <= f.floor) {
        f.y = f.floor;
        f.vy = 0;
        f.landed = true;
        sound.drop();
        if (navigator.vibrate) navigator.vibrate(12);
      }
    }
    f.x += f.vx * dt;
    f.d += f.vd * dt;
    if (Math.abs(f.x) > maxX) {
      f.x = Math.sign(f.x) * maxX;
      f.vx *= -0.2;
    }
    const pitEnd = TABLE.length + PIT_LEN - R - 0.02;
    if (f.d > pitEnd) {
      f.d = pitEnd;
      f.vd *= -0.25;
    }
    if (f.d < -0.2) {
      f.d = -0.2;
      f.vd = 0;
    }
    if (f.landed) {
      const sp = Math.hypot(f.vx, f.vd);
      const next = Math.max(0, sp - 4 * dt);
      if (sp > 0) {
        f.vx *= next / sp;
        f.vd *= next / sp;
      }
      f.tilt *= Math.exp(-dt * 12);
      if (next === 0 && Math.abs(f.tilt) < 0.01) w.status = "gone";
    } else {
      const drop = Math.min(1, -f.y / 0.06);
      f.tilt = overEnd ? -drop * 0.8 : Math.sign(f.x) * drop * 0.9;
    }
    const g = w.view.group;
    g.position.set(f.x, f.y, -f.d);
    if (overEnd) g.rotation.set(f.tilt, 0, 0);
    else g.rotation.set(0, 0, -f.tilt);
  }
  return busy;
}

function resolveShot(): void {
  let swept = 0;
  for (const w of weights) {
    if (w.status === "play" && w.body && !isLive(w.body)) {
      startFall(w, "sweep");
      swept++;
    }
  }
  if (swept) banner(swept > 1 ? "SHORT · WEIGHTS OFF" : "SHORT OF THE FOUL LINE", null, 1.2);
  phase = "resolving";
  resolveTimer = swept ? 0.9 : 0.35;
}

function endRound(): void {
  current = null;
  const live = weights.filter((w) => w.status === "play" && w.body);
  const result = scoreRound(live.map((w) => ({ team: w.team, x: w.body!.x, d: w.body!.d })));
  lastResult = result;
  phase = "roundEnd";
  stage.setCamera("head");
  hud.inset.classList.add("off");
  if (result.team !== null) scores[result.team] += result.points;
  result.counted.forEach((c) => {
    const w = live[c.index];
    stage.highlight(w.view, w.team);
    const el = document.createElement("div");
    el.className = "lbl";
    el.style.setProperty("--c", TEAM_COLORS[w.team]);
    el.innerHTML = `+${c.value}${c.hanger ? "<small>HANGER</small>" : ""}`;
    hud.labels.appendChild(el);
    labels.push({ el, w });
  });
  live.forEach((w) => {
    if (result.team !== null && w.team !== result.team) w.view.cap.emissiveIntensity = 0.02;
  });
  renderHud();
  setTimeout(() => {
    if (phase !== "roundEnd") return;
    const winner = matchWinner(scores, settings.target);
    if (winner !== null) {
      phase = "matchEnd";
      matchLive = false;
      sound.win();
      showCard(
        "MATCH OVER",
        `${teamName(winner)} WINS`,
        `${scores[winner]} – ${scores[winner === 0 ? 1 : 0]} after ${round} rounds`,
        winner,
        [
          ["REMATCH", newMatch],
          ["MENU", openMenu],
        ],
      );
    } else {
      if (result.team === null) sound.blank();
      else sound.score(result.points);
      const detail =
        result.team === null
          ? "No weight counted. Order stays the same."
          : result.counted.map((c) => (c.hanger ? `${c.zone}+1 hanger` : `${c.zone}`)).join(" · ") +
            ` — ${teamName(result.team)} throws first next round`;
      showCard(
        `ROUND ${round}`,
        result.team === null ? "BLANK ROUND" : `${teamName(result.team)} +${result.points}`,
        detail,
        result.team,
        [["NEXT ROUND", nextRound]],
      );
    }
  }, 900);
}

function nextRound(): void {
  if (!lastResult) return;
  firstShooter = nextFirstShooter(firstShooter, lastResult);
  round++;
  hideCard();
  hud.inset.classList.remove("off");
  startRound();
}

type CardArgs = [kicker: string, big: string, detail: string, team: Team | null, actions: [string, () => void][]];
let cardArgs: CardArgs | null = null;

function showCard(...args: CardArgs): void {
  cardArgs = args;
  const [kicker, big, detail, team, actions] = args;
  hud.card.style.setProperty("--c", team === null ? "#ffc21a" : TEAM_COLORS[team]);
  hud.card.querySelector(".k")!.textContent = kicker;
  hud.card.querySelector(".big")!.textContent = big;
  hud.card.querySelector(".detail")!.textContent = detail;
  hud.card.querySelector(".scoreline")!.innerHTML = ([0, 1] as Team[])
    .map((t) => `<span style="color:${TEAM_COLORS[t]}">${teamName(t)} <b>${scores[t]}</b></span>`)
    .join("<em>/</em>");
  const box = hud.card.querySelector(".actions")!;
  box.innerHTML = "";
  actions.forEach(([label, fn], i) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = i === 0 ? "go" : "ghost";
    b.onclick = () => {
      sound.tick();
      fn();
    };
    box.appendChild(b);
  });
  hud.card.classList.add("show");
}

function hideCard(): void {
  cardArgs = null;
  hud.card.classList.remove("show");
}

/* ---------------- Menu ---------------- */

const nameInputs = [$<HTMLInputElement>("nameA"), $<HTMLInputElement>("nameB")];

function syncMenu(): void {
  nameInputs.forEach((el, i) => (el.value = settings.names[i]));
  document.querySelectorAll<HTMLButtonElement>("#segTarget button").forEach((b) => b.classList.toggle("on", b.dataset.v === String(settings.target)));
  document.querySelectorAll<HTMLButtonElement>("#segMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === settings.mode));
  $("btnResume").style.display = matchLive ? "" : "none";
}

function readMenu(): void {
  settings.names = nameInputs.map((el, i) => el.value.trim().toUpperCase().slice(0, 12) || DEFAULT_NAMES[i]) as [string, string];
  localStorage.setItem("shuffle.settings", JSON.stringify(settings));
}

let resumePhase: Phase = "aim";
function openMenu(): void {
  if (phase !== "menu") resumePhase = phase;
  phase = "menu";
  syncMenu();
  hud.menu.classList.add("show");
  hud.card.classList.remove("show");
  if (!matchLive) stage.setCamera("overview");
}

function closeMenu(): void {
  hud.menu.classList.remove("show");
}

document.querySelectorAll<HTMLElement>(".seg").forEach((seg) =>
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    sound.tick();
    if (seg.id === "segTarget") settings.target = b.dataset.v === "15" ? 15 : 21;
    else {
      settings.mode = b.dataset.v === "cpu" ? "cpu" : "2p";
      if (settings.mode === "cpu" && nameInputs[1].value.trim().toUpperCase() === DEFAULT_NAMES[1]) nameInputs[1].value = "CPU";
      if (settings.mode === "2p" && nameInputs[1].value.trim().toUpperCase() === "CPU") nameInputs[1].value = DEFAULT_NAMES[1];
    }
    readMenu();
    syncMenu();
  }),
);

$("btnStart").onclick = () => {
  sound.unlock();
  sound.tick();
  readMenu();
  closeMenu();
  newMatch();
};
$("btnResume").onclick = () => {
  readMenu();
  closeMenu();
  phase = resumePhase;
  if (cardArgs) showCard(...cardArgs);
  renderHud();
};
$("btnMenu").onclick = () => {
  sound.tick();
  openMenu();
};
const soundBtn = $("btnSound");
const syncSound = () => soundBtn.classList.toggle("muted", sound.muted);
soundBtn.onclick = () => {
  sound.unlock();
  sound.setMuted(!sound.muted);
  syncSound();
};
syncSound();

/* ---------------- Input ---------------- */

interface Drag {
  id: number;
  sx: number;
  sy: number;
  x: number;
  samples: { x: number; y: number; t: number }[];
  mode: "idle" | "pull" | "flick";
  power: number;
  angle: number;
}
let drag: Drag | null = null;
const pullRange = () => Math.min(440, Math.max(220, window.innerHeight * 0.48));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

canvas.addEventListener("pointerdown", (e) => {
  sound.unlock();
  if (phase !== "aim" || !current || isCpuTurn()) return;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* pointer already released */
  }
  let x = current.view.group.position.x;
  const hit = stage.pickTable(e.clientX, e.clientY);
  if (hit && hit.d < 2.2 && hit.d > -0.6 && Math.abs(hit.x) < TABLE.width / 2 + 0.15) x = clamp(hit.x, -LANE, LANE);
  placeAim(x);
  drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x, samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }], mode: "idle", power: 0, angle: 0 };
  hud.hint.classList.remove("show");
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id || !current) return;
  drag.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
  if (drag.samples.length > 12) drag.samples.shift();
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (dy > 10) {
    drag.mode = "pull";
    drag.power = clamp((dy - 10) / pullRange(), 0, 1);
    drag.angle = clamp(Math.atan2(-dx, dy) * 0.45, -MAX_ANGLE, MAX_ANGLE);
    placeAim(drag.x, drag.power * 0.2);
    stage.showAim(drag.x, TABLE.launchD, drag.angle, drag.power, current.team);
    setPower(drag.power);
  } else {
    drag.mode = dy < -10 ? "flick" : "idle";
    placeAim(drag.x);
    stage.hideAim();
    setPower(null);
  }
});

function endDrag(e: PointerEvent, cancelled: boolean): void {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!current) return;
  if (!cancelled && d.mode === "pull" && d.power > 0.02) {
    launch(d.x, d.angle, speedOf(d.power));
    return;
  }
  if (!cancelled && d.mode === "flick") {
    // Velocity over the last ~50ms+ of the gesture; a pause before release kills the flick.
    let a = d.samples[0];
    for (let i = d.samples.length - 1; i >= 0; i--) {
      if (e.timeStamp - d.samples[i].t >= 50) {
        a = d.samples[i];
        break;
      }
    }
    const dt = Math.max(16, e.timeStamp - a.t);
    const vx = (e.clientX - a.x) / dt;
    const vy = (e.clientY - a.y) / dt;
    if (-vy > 0.25) {
      const power = clamp(-vy / 3.4, 0.05, 1);
      launch(d.x, clamp(Math.atan2(vx, -vy) * 0.45, -MAX_ANGLE, MAX_ANGLE), speedOf(power));
      return;
    }
  }
  placeAim(d.x);
  stage.hideAim();
  setPower(null);
  hud.hint.classList.add("show");
}
canvas.addEventListener("pointerup", (e) => endDrag(e, false));
canvas.addEventListener("pointercancel", (e) => endDrag(e, true));
canvas.addEventListener("lostpointercapture", (e) => endDrag(e, true));

/* ---------------- Loop ---------------- */

function stepCpu(dt: number): void {
  if (!cpu || !current) return;
  cpu.t += dt;
  const { shot } = cpu;
  const power = powerOf(shot.speed);
  if (cpu.t < 0) return;
  if (cpu.t < 0.5) {
    const k = cpu.t / 0.5;
    placeAim(cpu.fromX + (shot.x - cpu.fromX) * k * k * (3 - 2 * k));
  } else if (cpu.t < 1.4) {
    const k = Math.min(1, (cpu.t - 0.5) / 0.7);
    placeAim(shot.x, power * k * 0.2);
    stage.showAim(shot.x, TABLE.launchD, shot.angle, power * k, current.team);
    setPower(power * k);
  } else {
    cpu = null;
    launch(shot.x, shot.angle, shot.speed);
  }
}

function update(dt: number): void {
  if (bannerTimer > 0 && (bannerTimer -= dt) <= 0) hud.banner.classList.remove("show");
  if (phase === "aim" && isCpuTurn()) stepCpu(dt);

  let slideSpeed = 0;
  if (phase === "rolling") {
    for (const ev of world.step(dt)) {
      if (ev.type === "hit") {
        sound.clack(ev.impulse);
        if (navigator.vibrate && ev.impulse > 0.4) navigator.vibrate(8);
      } else {
        const w = weights.find((o) => o.body === world.bodies[ev.body]);
        if (w) startFall(w, ev.edge);
        if (ev.edge === "end") banner("OFF THE END", null, 1);
        else if (ev.edge === "side") banner("GUTTER", null, 1);
      }
    }
    let lead: number = TABLE.launchD;
    for (const w of weights) {
      if (w.status !== "play" || !w.body) continue;
      const b = w.body;
      w.view.group.position.set(b.x, 0, -b.d);
      const sp = Math.hypot(b.vx, b.vd);
      slideSpeed += sp;
      if (sp > 0.05) lead = Math.max(lead, b.d);
    }
    if (lead > TABLE.launchD) stage.setCamera("follow", lead);
  }
  const falling = stepFalls(dt);
  sound.slide(slideSpeed);

  if (phase === "rolling" && !world.moving && !falling) {
    resolveTimer += dt;
    if (resolveTimer > 0.45) resolveShot();
  } else if (phase === "resolving" && !falling) {
    resolveTimer -= dt;
    if (resolveTimer <= 0) {
      shotIndex++;
      if (shotIndex >= TABLE.weightsPerSide * 2) endRound();
      else nextTurn();
    }
  }

  if (labels.length) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
    labels.forEach(({ el, w }) => {
      const p = stage.toScreen(w.view.group.position.x, 0.1, -w.view.group.position.z);
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
      w.view.cap.emissiveIntensity = 0.3 + pulse * 0.9;
    });
  }
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  update(dt);
  stage.render(dt);
  requestAnimationFrame(frame);
}

window.addEventListener("resize", layout);
document.addEventListener("visibilitychange", () => {
  last = performance.now();
});

layout();
stage.setCamera("overview");
stage.snapCamera();
openMenu();
renderHud();
requestAnimationFrame(frame);
