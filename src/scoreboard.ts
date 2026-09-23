import { sourceLabel, type GameBody, type GameSummary, type Leader } from "./history.ts";

const UNSENT_KEY = "shuffle.unsent";
type Tab = "leaders" | "recent";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function unsent(): GameBody[] {
  try {
    const list = JSON.parse(localStorage.getItem(UNSENT_KEY) ?? "[]") as GameBody[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function post(game: GameBody): Promise<boolean> {
  try {
    const res = await fetch("/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(game),
    });
    // A 4xx will never succeed on retry, so drop it rather than queue forever.
    return res.ok || (res.status >= 400 && res.status < 500);
  } catch {
    return false;
  }
}

/** Save a finished local/CPU match to the shared history. Offline results are retried on next load. */
export async function recordGame(game: GameBody): Promise<void> {
  const queue = [...unsent().filter((g) => g.id !== game.id), game];
  const left: GameBody[] = [];
  for (const g of queue) if (!(await post(g))) left.push(g);
  localStorage.setItem(UNSENT_KEY, JSON.stringify(left.slice(-20)));
}

export async function flushUnsent(): Promise<void> {
  const queue = unsent();
  if (!queue.length) return;
  const left: GameBody[] = [];
  for (const g of queue) if (!(await post(g))) left.push(g);
  localStorage.setItem(UNSENT_KEY, JSON.stringify(left));
}

function when(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const days = Math.floor((Date.now() - t.getTime()) / 86_400_000);
  if (days < 1) return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return t.toLocaleDateString([], { weekday: "short" });
  return t.toLocaleDateString([], { day: "numeric", month: "short" });
}

function renderLeaders(leaders: Leader[], mine: Set<string>): string {
  if (!leaders.length) return `<p class="empty">No finished games yet. Win one.</p>`;
  return `<ol class="leaders">${leaders
    .map((l, i) => {
      const pct = l.games ? Math.round((l.wins / l.games) * 100) : 0;
      const me = mine.has(l.name.trim().toLowerCase()) ? " me" : "";
      return `<li class="${me}"><span class="rk">${i + 1}</span><b>${esc(l.name)}</b><span class="w">${l.wins}<small>W</small></span><span class="gp">${l.games}<small>GP</small></span><span class="pct">${pct}%</span></li>`;
    })
    .join("")}</ol>`;
}

function renderRecent(games: GameSummary[]): string {
  if (!games.length) return `<p class="empty">No finished games yet.</p>`;
  return `<ul class="recent">${games
    .map((g) => {
      const side = (i: 0 | 1) =>
        `<span class="p${g.winnerIndex === i ? " won" : ""}"><b>${esc(g.names[i])}</b><em>${g.scores[i]}</em></span>`;
      return `<li><div class="meta"><span class="src">${esc(sourceLabel(g.meta))}</span><span>TO ${g.target}</span><span>${esc(when(g.playedAt))}</span></div><div class="line">${side(0)}<i>–</i>${side(1)}</div></li>`;
    })
    .join("")}</ul>`;
}

export class Scoreboard {
  private tab: Tab = "leaders";
  private mine = new Set<string>();
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly onTick: () => void;
  private loadId = 0;

  constructor(root: HTMLElement, onTick: () => void) {
    this.root = root;
    this.onTick = onTick;
    this.body = root.querySelector<HTMLElement>(".list")!;
    root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        this.onTick();
        this.tab = b.dataset.tab === "recent" ? "recent" : "leaders";
        void this.load();
      }),
    );
    root.querySelector<HTMLButtonElement>("[data-close]")!.addEventListener("click", () => {
      this.onTick();
      this.close();
    });
  }

  open(names: readonly string[] = []): void {
    this.mine = new Set(names.map((n) => n.trim().toLowerCase()));
    this.root.classList.add("show");
    void this.load();
  }

  close(): void {
    this.root.classList.remove("show");
  }

  private async load(): Promise<void> {
    const id = ++this.loadId;
    this.root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    this.body.innerHTML = `<p class="empty">Loading…</p>`;
    try {
      const path = this.tab === "leaders" ? "/api/leaderboard?limit=25" : "/api/games?limit=30";
      const res = await fetch(path);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { leaders?: Leader[]; games?: GameSummary[] };
      if (id !== this.loadId) return;
      this.body.innerHTML = this.tab === "leaders" ? renderLeaders(data.leaders ?? [], this.mine) : renderRecent(data.games ?? []);
    } catch {
      if (id !== this.loadId) return;
      this.body.innerHTML = `<p class="empty">Scoreboard is offline right now. Finished games are kept and sent later.</p>`;
    }
  }
}
