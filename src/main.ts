import "./style.css";
import { MAX_ANGLE, planCpuShot, powerOf, speedOf, type Shot } from "./ai.ts";
import { Sound } from "./audio.ts";
import { gameBody } from "./history.ts";
import { roundLog, weightsLeft, type MatchState, type RoundLog, type ShotInput } from "./match.ts";
import { OnlineClient, clearTicket, createRoom, joinRoom, loadTicket, roomLink, roomPreview, saveTicket, type LinkState } from "./online.ts";
import { World, type Body } from "./physics.ts";
import type { AimInput, RoomSnapshot, RoomTicket, ServerMsg } from "./protocol.ts";
import { codeFromLocation, isRoomCode, normalizeCode, randomToken } from "./room-code.ts";
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
import { Scoreboard, flushUnsent, recordGame } from "./scoreboard.ts";

type Mode = "2p" | "cpu" | "online";
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
  /** Shot index within the round; matches the online room's weight ids. */
  id?: number;
}

/** `settle`: an online shot has finished animating and is waiting for the room's result. */
type Phase = "menu" | "aim" | "rolling" | "resolving" | "settle" | "roundEnd" | "matchEnd";

const R = TABLE.puckRadius;
const LANE = TABLE.width / 2 - R - 0.02;
const CPU: Team = 1;
const DEFAULT_NAMES: [string, string] = ["ORANGE", "CYAN"];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("c");
const stage = new Stage(canvas);
const sound = new Sound();
const world = new World();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const other = (t: Team) => (1 - t) as Team;

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem("shuffle.settings") ?? "") as Partial<Settings>;
    return {
      names: [s.names?.[0] || DEFAULT_NAMES[0], s.names?.[1] || DEFAULT_NAMES[1]],
      target: s.target === 15 ? 15 : 21,
      mode: s.mode === "cpu" || s.mode === "online" ? s.mode : "2p",
    };
  } catch {
    return { names: [...DEFAULT_NAMES], target: 21, mode: "2p" };
  }
}

let settings = loadSettings();
let phase: Phase = "menu";
let matchLive = false;
/** Mode of the match on the table (the menu's selection can differ until a new game starts). */
let matchMode: Mode = settings.mode === "cpu" ? "cpu" : "2p";
let matchId = "";
let roundsLog: RoundLog[] = [];
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
let endToken = 0;

/* Online */
type ShotMsg = Extract<ServerMsg, { t: "shot" }>;
let net: OnlineClient | null = null;
let seat: Team | null = null;
let link: LinkState = "connecting";
let room: RoomSnapshot | null = null;
/** Shots this browser has put on the table in the current room; equals the room's `seq` when in sync. */
let localSeq = 0;
let pendingShot: { seq: number; shot: ShotInput } | null = null;
let awaiting: RoomSnapshot | null = null;
let remoteShots: ShotMsg[] = [];
let rejectPending = false;
let remoteAim: { target: AimInput; x: number; angle: number; power: number } | null = null;
let settleWait = 0;

const isOnline = () => matchMode === "online" && net !== null;
const isCpuTurn = () => matchMode === "cpu" && current?.team === CPU;
const isRemoteTurn = () => isOnline() && !!current && current.team !== seat;
const opponentHere = () => seat !== null && !!room?.players[other(seat)]?.connected;
const teamName = (t: Team) => (matchMode === "online" && room?.players[t]?.name) || settings.names[t];
const busy = () => phase === "rolling" || phase === "resolving" || phase === "settle";

function canShoot(): boolean {
  if (phase !== "aim" || !current || isCpuTurn()) return false;
  if (matchMode !== "online") return true;
  return current.team === seat && !!net?.isOpen && opponentHere();
}

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
  net: $("net"),
};

function renderHud(): void {
  ([0, 1] as Team[]).forEach((t) => {
    const el = hud.team[t];
    let tag = "";
    if (matchMode === "cpu" && t === CPU && teamName(t) !== "CPU") tag = " · CPU";
    if (matchMode === "online" && t === seat) tag = " · YOU";
    el.querySelector(".name")!.textContent = teamName(t) + tag;
    el.querySelector(".score")!.textContent = String(scores[t]);
    el.classList.toggle("active", !!current && current.team === t && (phase === "aim" || phase === "rolling"));
    const pips = el.querySelector(".pips")!;
    const mine = weights.filter((w) => w.team === t);
    pips.innerHTML = mine
      .map((w) => `<i class="${w.status === "rack" ? "full" : w.status === "aim" ? "now" : ""}"></i>`)
      .join("");
  });
  hud.round.textContent = String(round);
  hud.target.textContent = String(matchMode === "online" && room ? room.target : settings.target);
  updateNet();
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

function turnHint(): string {
  if (!current) return "";
  if (isCpuTurn()) return "CPU is lining up…";
  if (matchMode !== "online") return "Pull back & release · or flick forward";
  if (current.team !== seat) return `${teamName(current.team)} is lining up…`;
  if (!net?.isOpen) return "Reconnecting…";
  if (!opponentHere()) return `Paused until ${teamName(other(seat!))} is back`;
  return "Your turn · pull back & release";
}

function updateNet(): void {
  const show = matchMode === "online" && !!net && room?.status === "playing";
  hud.net.classList.toggle("show", show);
  if (!show || seat === null) return;
  let text = `ROOM ${room!.code}`;
  let color = "#ffc21a";
  let warn = false;
  if (link !== "open") {
    text = "RECONNECTING…";
    warn = true;
  } else if (!opponentHere()) {
    text = `${teamName(other(seat))} OFFLINE · PAUSED`;
    warn = true;
  } else if (current && (phase === "aim" || busy())) {
    text = current.team === seat ? "YOUR TURN" : `${teamName(current.team)}'S TURN`;
    color = TEAM_COLORS[current.team];
  }
  hud.net.querySelector("span")!.textContent = text;
  hud.net.style.setProperty("--c", color);
  hud.net.classList.toggle("warn", warn);
  if (phase === "aim" && current && !drag) {
    hud.hint.textContent = turnHint();
    hud.hint.classList.add("show");
  }
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
  hud.net.style.top = `${Math.round(top - 2)}px`;
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

function newMatch(mode: "2p" | "cpu" = matchMode === "cpu" ? "cpu" : "2p"): void {
  matchMode = mode;
  matchId = randomToken(8);
  roundsLog = [];
  scores = [0, 0];
  round = 1;
  firstShooter = 0;
  lastPower[0] = lastPower[1] = null;
  matchLive = true;
  hideCard();
  hud.inset.classList.remove("off");
  startRound();
}

function startRound(): void {
  endToken++;
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
  remoteAim = null;
  stage.setCamera("aim");
  stage.hideAim();
  const left = TABLE.weightsPerSide - Math.floor(shotIndex / 2);
  const mine = matchMode === "online" && team === seat;
  if (mine) sound.chime();
  setTimeout(() => {
    if (phase === "aim" && current?.team === team) banner(mine ? `YOUR TURN · ${left} LEFT` : `${teamName(team)} · ${left} LEFT`, team, 1.4);
  }, shotIndex === 0 ? 1100 : 0);
  hud.hint.textContent = turnHint();
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

function launch(x: number, angle: number, speed: number, remote = false): void {
  if (!current || phase !== "aim") return;
  const w = current;
  lastX[w.team] = x;
  lastPower[w.team] = powerOf(speed);
  w.id = shotIndex;
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
  if (matchMode === "online") {
    if (!remote) {
      pendingShot = { seq: localSeq, shot: { x, angle, speed } };
      net?.send({ t: "shot", seq: localSeq, shot: pendingShot.shot });
    }
    localSeq++;
  }
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

/** Ends the round on the table. Online, `auth` is the room's state and its scores win. */
function endRound(auth: MatchState | null = null): void {
  current = null;
  const live = weights.filter((w) => w.status === "play" && w.body);
  const result = scoreRound(live.map((w) => ({ team: w.team, x: w.body!.x, d: w.body!.d })));
  lastResult = result;
  stage.setCamera("head");
  hud.inset.classList.add("off");
  if (auth) scores = [auth.scores[0], auth.scores[1]];
  else {
    if (result.team !== null) scores[result.team] += result.points;
    roundsLog.push(roundLog(round, result, scores, firstShooter));
  }
  const winner = auth ? auth.winner : matchWinner(scores, settings.target);
  phase = winner === null ? "roundEnd" : "matchEnd";
  if (winner !== null) matchLive = false;
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
  const token = ++endToken;
  setTimeout(() => {
    if (token !== endToken) return;
    if (winner !== null) {
      sound.win();
      if (!auth) saveLocalMatch(winner);
      const loser = other(winner);
      const big = matchMode === "online" && winner === seat ? "YOU WIN" : `${teamName(winner)} WINS`;
      cardKind = "match";
      showCard("MATCH OVER", big, `${scores[winner]} – ${scores[loser]} after ${round} rounds`, winner, cardActions());
    } else {
      if (result.team === null) sound.blank();
      else sound.score(result.points);
      const detail =
        result.team === null
          ? "No weight counted. Order stays the same."
          : result.counted.map((c) => (c.hanger ? `${c.zone}+1 hanger` : `${c.zone}`)).join(" · ") +
            ` — ${teamName(result.team)} throws first next round`;
      cardKind = "round";
      showCard(
        `ROUND ${round}`,
        result.team === null ? "BLANK ROUND" : `${teamName(result.team)} +${result.points}`,
        detail,
        result.team,
        cardActions(),
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

function saveLocalMatch(winner: Team): void {
  const mode = matchMode === "cpu" ? "cpu" : "local";
  void recordGame(
    gameBody({
      id: `s3d-${mode}-${matchId}`,
      names: settings.names,
      scores,
      target: settings.target,
      winner,
      rounds: roundsLog,
      mode,
    }),
  );
}

type CardAction = [label: string, fn: () => void, disabled?: boolean];
type CardArgs = [kicker: string, big: string, detail: string, team: Team | null, actions: CardAction[]];
let cardArgs: CardArgs | null = null;
let cardKind: "round" | "match" | null = null;

function cardActions(): CardAction[] {
  const board: CardAction = ["SCORES", () => openBoard()];
  if (matchMode !== "online") {
    return cardKind === "match" ? [["REMATCH", () => newMatch()], board, ["MENU", () => openMenu()]] : [["NEXT ROUND", nextRound]];
  }
  const me = seat ?? 0;
  const waiting: CardAction = [`WAITING FOR ${teamName(other(me))}…`, () => {}, true];
  const ready = !!room?.ready[me];
  if (cardKind === "match") return [ready ? waiting : ["REMATCH", readyUp], board, ["LEAVE", () => exitRoom(true)]];
  return [ready ? waiting : ["NEXT ROUND", readyUp]];
}

function showCard(...args: CardArgs): void {
  cardArgs = args;
  const [kicker, big, detail, team, actions] = args;
  hud.card.style.setProperty("--c", team === null ? "#ffc21a" : TEAM_COLORS[team]);
  hud.card.querySelector(".k")!.textContent = kicker;
  hud.card.querySelector(".big")!.textContent = big;
  let sub = detail;
  if (matchMode === "online" && seat !== null && room?.ready[other(seat)] && !room.ready[seat]) sub += ` · ${teamName(other(seat))} is ready`;
  hud.card.querySelector(".detail")!.textContent = sub;
  hud.card.querySelector(".scoreline")!.innerHTML = ([0, 1] as Team[])
    .map((t) => `<span style="color:${TEAM_COLORS[t]}">${esc(teamName(t))} <b>${scores[t]}</b></span>`)
    .join("<em>/</em>");
  const box = hud.card.querySelector(".actions")!;
  box.innerHTML = "";
  actions.forEach(([label, fn, disabled], i) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = i === 0 ? "go" : "ghost";
    b.disabled = !!disabled;
    b.onclick = () => {
      sound.tick();
      fn();
    };
    box.appendChild(b);
  });
  if (!hud.menu.classList.contains("show")) hud.card.classList.add("show");
}

function hideCard(): void {
  cardArgs = null;
  cardKind = null;
  hud.card.classList.remove("show");
}

/** Re-draw the round/match card after the room's ready flags change. */
function refreshCard(): void {
  if (!cardArgs || !cardKind) return;
  const [k, big, detail, team] = cardArgs;
  showCard(k, big, detail, team, cardActions());
}

/* ---------------- Online ---------------- */

function readyUp(): void {
  if (!net || seat === null || !room) return;
  net.send({ t: "ready" });
  room.ready[seat] = true;
  refreshCard();
}

/** Drop whatever is on the table (a local match being abandoned, or before an online rebuild). */
function abandonTable(): void {
  endToken++;
  clearWeights();
  hideCard();
  current = null;
  cpu = null;
  drag = null;
  phase = "menu";
  matchLive = false;
  scores = [0, 0];
  round = 1;
  stage.hideAim();
  setPower(null);
  hud.hint.classList.remove("show");
  hud.inset.classList.remove("off");
  stage.setCamera("overview");
  renderHud();
}

function enterRoom(t: RoomTicket, resuming = false): void {
  net?.close();
  saveTicket(t);
  abandonTable();
  seat = t.seat;
  room = null;
  localSeq = 0;
  pendingShot = null;
  awaiting = null;
  remoteShots = [];
  link = "connecting";
  matchMode = "online";
  let welcomed = false;
  net = new OnlineClient(t, {
    message: (msg) => {
      if (msg.t === "welcome") welcomed = true;
      onServer(msg);
    },
    link: (state) => {
      link = state;
      if (room?.status === "lobby" || !room) showLobby();
      renderHud();
    },
    gone: (reason) => exitRoom(false, resuming && !welcomed ? "" : reason),
  });
  closeMenu();
  showLobby();
  if (location.pathname !== `/join/${t.code}`) history.replaceState(null, "", `/join/${t.code}`);
}

/** Leave the online room (telling it, if `tell`), then go back to the menu. */
function exitRoom(tell: boolean, message = ""): void {
  if (tell) net?.send({ t: "leave" });
  net?.close();
  net = null;
  clearTicket();
  seat = null;
  room = null;
  pendingShot = null;
  awaiting = null;
  remoteShots = [];
  remoteAim = null;
  matchMode = settings.mode === "cpu" ? "cpu" : "2p";
  hideLobby();
  abandonTable();
  if (location.pathname !== "/" || location.search) history.replaceState(null, "", "/");
  openMenu();
  menuMsg(message, !!message);
}

function onServer(msg: ServerMsg): void {
  switch (msg.t) {
    case "welcome":
      seat = msg.seat;
      onRoom(msg.room, true);
      return;
    case "state":
      onRoom(msg.room);
      return;
    case "shot":
      room = msg.room;
      if (pendingShot && msg.seat === seat && msg.seq === pendingShot.seq) {
        pendingShot = null;
        awaiting = msg.room;
      } else {
        remoteShots.push(msg);
        pump();
      }
      renderHud();
      return;
    case "aim":
      if (!isRemoteTurn() || phase !== "aim" || !current) return;
      if (!remoteAim) {
        const x = current.view.group.position.x;
        remoteAim = { target: { x, angle: 0, power: 0 }, x, angle: 0, power: 0 };
      }
      remoteAim.target = msg.aim ?? { ...remoteAim.target, power: 0, angle: 0 };
      return;
    case "error":
      if (pendingShot) rejectPending = true;
      hud.hint.textContent = msg.message;
      hud.hint.classList.add("show");
      return;
  }
}

function onRoom(r: RoomSnapshot, welcome = false): void {
  const before = room;
  room = r;
  if (r.status === "closed") return exitRoom(false, r.reason ?? "The room was closed.");
  if (seat !== null && before && r.players[other(seat)]?.connected && !before.players[other(seat)]?.connected) sound.chime();
  if (rejectPending) {
    rejectPending = false;
    pendingShot = null;
    awaiting = null;
    remoteShots = [];
    if (r.match) return applySnapshot(r);
  }
  if (pendingShot && r.seq > pendingShot.seq) pendingShot = null;
  if (welcome && pendingShot && r.seq === pendingShot.seq) net?.send({ t: "shot", seq: pendingShot.seq, shot: pendingShot.shot });
  if (r.status === "lobby" || !r.match) {
    if (matchMode === "online" && phase !== "menu") abandonTable();
    showLobby();
    return;
  }
  hideLobby();
  pump();
  renderHud();
}

function inSync(r: RoomSnapshot): boolean {
  const m = r.match;
  if (!m || matchMode !== "online") return false;
  const kind = phase === "aim" || phase === "roundEnd" || phase === "matchEnd" ? phase : null;
  return r.seq === localSeq && m.round === round && m.shotIndex === shotIndex && m.phase === kind;
}

/** Bring the table up to the room: animate the next opponent shot, or rebuild if out of step. */
function pump(): void {
  if (!room?.match || matchMode !== "online" || busy()) return;
  remoteShots = remoteShots.filter((s) => s.seq >= localSeq);
  const next = remoteShots.shift();
  if (next) {
    if (playRemote(next)) return;
    remoteShots = [];
  }
  if (!inSync(room)) applySnapshot(room);
  else refreshCard();
}

function playRemote(msg: ShotMsg): boolean {
  const m = msg.room.match;
  if (!m || phase !== "aim" || !current || current.team !== msg.seat) return false;
  if (msg.seq !== localSeq || m.round !== round || m.shotIndex !== shotIndex + 1) return false;
  awaiting = msg.room;
  remoteAim = null;
  placeAim(msg.shot.x);
  launch(msg.shot.x, msg.shot.angle, msg.shot.speed, true);
  return true;
}

/** Called each frame in `settle` until the room's result for the last shot is known. */
function trySettle(): void {
  if (awaiting) {
    const r = awaiting;
    awaiting = null;
    settleTo(r);
    return;
  }
  if (room?.match && room.seq >= localSeq && !pendingShot) return applySnapshot(room);
  if (settleWait > 1.5) {
    hud.hint.textContent = net?.isOpen ? "Syncing with the room…" : "Reconnecting…";
    hud.hint.classList.add("show");
  }
}

function settleTo(r: RoomSnapshot): void {
  const m = r.match;
  if (!m || r.status !== "playing" || m.round !== round) return applySnapshot(room ?? r);
  const byId = new Map(m.table.map((w) => [w.id, w]));
  for (const w of weights) {
    if (w.id === undefined || !w.body) continue;
    const auth = byId.get(w.id);
    if (auth) {
      if (w.status !== "play") {
        w.fall = undefined;
        w.status = "play";
      }
      Object.assign(w.body, { x: auth.x, d: auth.d, vx: 0, vd: 0, active: true });
      w.view.group.position.set(auth.x, 0, -auth.d);
      w.view.group.rotation.set(0, 0, 0);
    } else if (w.status === "play" || w.status === "falling") {
      w.body.active = false;
      w.status = "gone";
      w.view.group.visible = false;
    }
  }
  hud.hint.classList.remove("show");
  shotIndex = m.shotIndex;
  firstShooter = m.firstShooter;
  scores = [m.scores[0], m.scores[1]];
  if (m.phase === "aim") nextTurn();
  else endRound(m);
  pump();
}

/** Rebuild the table from a room snapshot (join, reconnect, new round, or recovery). */
function applySnapshot(r: RoomSnapshot): void {
  const m = r.match;
  if (!m) return;
  hideLobby();
  hideCard();
  endToken++;
  const newRound = matchMode !== "online" || m.round !== round || !matchLive;
  matchMode = "online";
  matchLive = m.phase !== "matchEnd";
  clearWeights();
  cpu = null;
  drag = null;
  awaiting = null;
  pendingShot = null;
  remoteShots = [];
  remoteAim = null;
  localSeq = r.seq;
  round = m.round;
  firstShooter = m.firstShooter;
  shotIndex = m.shotIndex;
  scores = [m.scores[0], m.scores[1]];
  lastResult = null;
  for (const tw of m.table) {
    const w: Weight = { team: tw.team, view: stage.createPuck(tw.team), body: { x: tw.x, d: tw.d, vx: 0, vd: 0, active: true }, status: "play", id: tw.id };
    w.view.group.position.set(tw.x, 0, -tw.d);
    world.bodies.push(w.body!);
    weights.push(w);
  }
  for (const team of [0, 1] as Team[]) {
    for (let i = 0; i < weightsLeft(m, team); i++) weights.push({ team, view: stage.createPuck(team), body: null, status: "rack" });
  }
  weights.filter((w) => w.status === "rack").forEach(rackPosition);
  hud.inset.classList.remove("off");
  stage.hideAim();
  if (m.phase === "aim") {
    if (m.shotIndex === 0 && newRound) banner(`ROUND ${round}`, null, 1.3);
    nextTurn();
  } else endRound(m);
  renderHud();
}

/* ---------------- Lobby ---------------- */

const lobby = {
  root: $("lobby"),
  code: $<HTMLButtonElement>("lobbyCode"),
  link: $("lobbyLink"),
  target: $("lobbyTarget"),
  seats: [$("seat0"), $("seat1")],
  status: $("lobbyStatus"),
  start: $<HTMLButtonElement>("btnLobbyStart"),
  share: $<HTMLButtonElement>("btnShare"),
  copy: $<HTMLButtonElement>("btnCopy"),
};

function showLobby(): void {
  if (!net || hud.menu.classList.contains("show")) return;
  const code = room?.code ?? net.ticket.code;
  lobby.code.textContent = code;
  lobby.link.textContent = roomLink(code).replace(/^https?:\/\//, "");
  lobby.target.textContent = String(room?.target ?? settings.target);
  ([0, 1] as Team[]).forEach((s) => {
    const p = room?.players[s];
    const role = (s === 0 ? "HOST" : "GUEST") + (s === seat ? " · YOU" : "");
    lobby.seats[s].innerHTML = p
      ? `<i class="dot${p.connected ? " on" : ""}"></i><b>${esc(p.name)}</b><span>${p.connected ? role : "OFFLINE"}</span>`
      : `<i class="dot"></i><b class="wait">Waiting for opponent<em>.</em><em>.</em><em>.</em></b><span>${role}</span>`;
  });
  const opp = seat === null ? null : room?.players[other(seat)];
  let status: string;
  if (!room || link !== "open") status = link === "reconnecting" ? "Reconnecting…" : "Connecting…";
  else if (seat === 0) status = opp?.connected ? `${opp.name} is here. Start when you're ready.` : "Share the code or link with your opponent.";
  else status = room.players[0]?.connected ? `Waiting for ${room.players[0].name} to start…` : "The host is offline. Hang tight.";
  lobby.status.textContent = status;
  lobby.start.style.display = seat === 0 ? "" : "none";
  lobby.start.disabled = !(link === "open" && opp?.connected);
  hud.net.classList.remove("show");
  lobby.root.classList.add("show");
}

function hideLobby(): void {
  lobby.root.classList.remove("show");
}

function flash(btn: HTMLButtonElement, text: string): void {
  const was = btn.dataset.label ?? btn.textContent ?? "";
  btn.dataset.label = was;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = was), 1300);
}

async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash(btn, "COPIED");
  } catch {
    flash(btn, "COPY FAILED");
  }
}

lobby.code.onclick = () => {
  sound.tick();
  const code = lobby.code.textContent ?? "";
  void navigator.clipboard?.writeText(code).then(
    () => {
      lobby.code.classList.add("copied");
      setTimeout(() => lobby.code.classList.remove("copied"), 900);
    },
    () => {},
  );
};
lobby.copy.onclick = () => {
  sound.tick();
  if (net) void copyText(roomLink(net.ticket.code), lobby.copy);
};
lobby.share.onclick = async () => {
  sound.tick();
  if (!net) return;
  const url = roomLink(net.ticket.code);
  if (navigator.share) {
    try {
      await navigator.share({ title: "SHUFFLE", text: `Play me at SHUFFLE. Room ${net.ticket.code}`, url });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  void copyText(url, lobby.share);
};
lobby.start.onclick = () => {
  sound.unlock();
  sound.tick();
  net?.send({ t: "start" });
};
$("btnLobbyLeave").onclick = () => {
  sound.tick();
  exitRoom(true);
};

/* ---------------- Menu ---------------- */

const nameInputs = [$<HTMLInputElement>("nameA"), $<HTMLInputElement>("nameB")];
const joinCode = $<HTMLInputElement>("joinCode");
const menuMsgEl = $("menuMsg");
const board = new Scoreboard($("board"), () => sound.tick());

function openBoard(): void {
  const names = matchMode === "online" && room ? room.players.map((p) => p?.name ?? "") : settings.names;
  board.open(names);
}

function menuMsg(text: string, error = false): void {
  menuMsgEl.textContent = text;
  menuMsgEl.classList.toggle("err", error);
}

function syncMenu(): void {
  const online = settings.mode === "online";
  nameInputs.forEach((el, i) => (el.value = settings.names[i]));
  document.querySelectorAll<HTMLButtonElement>("#segTarget button").forEach((b) => b.classList.toggle("on", b.dataset.v === String(settings.target)));
  document.querySelectorAll<HTMLButtonElement>("#segMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === settings.mode));
  $("names").classList.toggle("solo", online);
  $("labelA").textContent = online ? "Your name" : "Orange";
  $("nameBWrap").style.display = online ? "none" : "";
  $("rowTarget").style.display = online && net ? "none" : "";
  const start = $<HTMLButtonElement>("btnStart");
  start.textContent = online ? "HOST ONLINE GAME" : "NEW GAME";
  start.style.display = online && net ? "none" : "";
  $("joinBox").style.display = online && !net ? "" : "none";
  $("btnResume").style.display = matchLive || net ? "" : "none";
  $("btnLeave").style.display = net ? "" : "none";
}

function readMenu(): void {
  settings.names = nameInputs.map((el, i) => el.value.trim().toUpperCase().slice(0, 12) || (settings.mode === "online" && i === 1 ? settings.names[1] : DEFAULT_NAMES[i])) as [string, string];
  localStorage.setItem("shuffle.settings", JSON.stringify(settings));
}

let resumePhase: Phase = "aim";
function openMenu(): void {
  // Online play keeps running under the menu; the room doesn't pause for one player's menu.
  if (!isOnline() && phase !== "menu") {
    resumePhase = phase;
    phase = "menu";
  }
  menuMsg("");
  syncMenu();
  hideLobby();
  hud.menu.classList.add("show");
  hud.card.classList.remove("show");
  if (!matchLive && !isOnline()) stage.setCamera("overview");
}

function closeMenu(): void {
  hud.menu.classList.remove("show");
}

document.querySelectorAll<HTMLElement>(".seg[id]").forEach((seg) =>
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    sound.tick();
    readMenu();
    if (seg.id === "segTarget") settings.target = b.dataset.v === "15" ? 15 : 21;
    else {
      settings.mode = b.dataset.v === "cpu" ? "cpu" : b.dataset.v === "online" ? "online" : "2p";
      if (settings.mode === "cpu" && nameInputs[1].value.trim().toUpperCase() === DEFAULT_NAMES[1]) settings.names[1] = "CPU";
      if (settings.mode === "2p" && nameInputs[1].value.trim().toUpperCase() === "CPU") settings.names[1] = DEFAULT_NAMES[1];
    }
    localStorage.setItem("shuffle.settings", JSON.stringify(settings));
    menuMsg("");
    syncMenu();
  }),
);

let menuBusy = false;
async function withBusy(label: string, fn: () => Promise<void>): Promise<void> {
  if (menuBusy) return;
  menuBusy = true;
  menuMsg(label);
  document.querySelectorAll<HTMLButtonElement>("#btnStart, #btnJoin").forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (e) {
    menuMsg(e instanceof Error ? e.message : "Something went wrong.", true);
  } finally {
    menuBusy = false;
    document.querySelectorAll<HTMLButtonElement>("#btnStart, #btnJoin").forEach((b) => (b.disabled = false));
  }
}

function hostOnline(): Promise<void> {
  return withBusy("Creating a room…", async () => {
    const t = await createRoom(settings.names[0], settings.target);
    enterRoom(t);
  });
}

function joinOnline(code: string): Promise<void> {
  if (!isRoomCode(code)) {
    menuMsg("Room codes are 5 letters and numbers, like K7QMX.", true);
    return Promise.resolve();
  }
  const saved = loadTicket();
  if (saved?.code === code) {
    enterRoom(saved);
    return Promise.resolve();
  }
  return withBusy("Joining…", async () => {
    const t = await joinRoom(code, settings.names[0]);
    enterRoom(t);
  });
}

function prepareJoin(code: string): void {
  settings.mode = "online";
  syncMenu();
  joinCode.value = code;
  menuMsg(`Room ${code}. Enter your name and tap JOIN.`);
  roomPreview(code).then(
    (p) => {
      if (joinCode.value !== code) return;
      if (!p) menuMsg(`Room ${code} has closed or expired.`, true);
      else if (!p.open) menuMsg(`Room ${code} already has two players.`, true);
      else menuMsg(`${p.host}'s room · play to ${p.target}. Enter your name and tap JOIN.`);
    },
    () => {},
  );
}

$("btnStart").onclick = () => {
  sound.unlock();
  sound.tick();
  readMenu();
  if (settings.mode === "online") return void hostOnline();
  if (net) exitRoom(true);
  closeMenu();
  newMatch(settings.mode === "cpu" ? "cpu" : "2p");
};
$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  sound.unlock();
  sound.tick();
  readMenu();
  joinCode.blur();
  void joinOnline(normalizeCode(joinCode.value));
});
joinCode.addEventListener("input", () => {
  const v = normalizeCode(joinCode.value);
  if (v !== joinCode.value) joinCode.value = v;
});
$("btnResume").onclick = () => {
  readMenu();
  closeMenu();
  if (isOnline()) {
    if (!room?.match) showLobby();
    else if (cardArgs) showCard(...cardArgs);
    renderHud();
    return;
  }
  phase = resumePhase;
  if (cardArgs) showCard(...cardArgs);
  renderHud();
};
$("btnLeave").onclick = () => {
  sound.tick();
  exitRoom(true);
};
$("btnBoard").onclick = () => {
  sound.tick();
  openBoard();
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
const shareAim = (x: number, angle = 0, power = 0) => {
  if (isOnline()) net!.sendAim({ x, angle, power });
};

canvas.addEventListener("pointerdown", (e) => {
  sound.unlock();
  if (!canShoot() || !current) return;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* pointer already released */
  }
  let x = current.view.group.position.x;
  const hit = stage.pickTable(e.clientX, e.clientY);
  if (hit && hit.d < 2.2 && hit.d > -0.6 && Math.abs(hit.x) < TABLE.width / 2 + 0.15) x = clamp(hit.x, -LANE, LANE);
  placeAim(x);
  shareAim(x);
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
    shareAim(drag.x, drag.angle, drag.power);
  } else {
    drag.mode = dy < -10 ? "flick" : "idle";
    placeAim(drag.x);
    stage.hideAim();
    setPower(null);
    shareAim(drag.x);
  }
});

function endDrag(e: PointerEvent, cancelled: boolean): void {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!current || phase !== "aim") return;
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
  shareAim(d.x);
  hud.hint.textContent = turnHint();
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

function stepRemoteAim(dt: number): void {
  if (!remoteAim || !current) return;
  const a = remoteAim;
  const k = 1 - Math.exp(-dt * 14);
  a.x += (a.target.x - a.x) * k;
  a.angle += (a.target.angle - a.angle) * k;
  a.power += (a.target.power - a.power) * k;
  placeAim(a.x, a.power * 0.2);
  if (a.power > 0.02) {
    stage.showAim(a.x, TABLE.launchD, a.angle, a.power, current.team);
    setPower(a.power);
  } else {
    stage.hideAim();
    setPower(null);
  }
}

function update(dt: number): void {
  if (bannerTimer > 0 && (bannerTimer -= dt) <= 0) hud.banner.classList.remove("show");
  if (phase === "aim" && isCpuTurn()) stepCpu(dt);
  if (phase === "aim" && isRemoteTurn()) stepRemoteAim(dt);

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
      if (matchMode === "online") {
        phase = "settle";
        settleWait = 0;
      } else {
        shotIndex++;
        if (shotIndex >= TABLE.weightsPerSide * 2) endRound();
        else nextTurn();
      }
    }
  }
  if (phase === "settle") {
    settleWait += dt;
    trySettle();
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
renderHud();
void flushUnsent();

const linkCode = codeFromLocation(location.pathname, location.search);
const saved = loadTicket();
if (saved && (!linkCode || linkCode === saved.code)) enterRoom(saved, true);
else {
  openMenu();
  if (linkCode) prepareJoin(linkCode);
  else if (location.pathname !== "/") history.replaceState(null, "", "/");
}
requestAnimationFrame(frame);
