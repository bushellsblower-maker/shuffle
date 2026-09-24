import { LoadingManager } from "three";

/** One piece of start-up work. It may return a promise (shader compiles). */
export type LoadStep = readonly [name: string, run: () => unknown];

export interface LoadingView {
  /** `fraction` runs 0 → 1. */
  progress(fraction: number): void;
  hide(): void;
}

interface Options {
  /** Resolves once the browser has painted, so the bar moves before the next step blocks the thread. */
  paint?: () => Promise<void>;
  /** A step that hasn't finished by then is abandoned and the overlay comes down anyway. */
  stepTimeout?: number;
}

const READY = "first frame";

export const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/**
 * Start-up progress, counted by a three.js `LoadingManager` so any URL loader
 * given `manager` joins the same bar. The last item is the game's first frame
 * (`ready`); the overlay goes when every item is in, or on the first failure.
 */
export class Loading {
  readonly manager = new LoadingManager();
  private readonly view: LoadingView;
  private readonly paint: () => Promise<void>;
  private readonly stepTimeout: number;
  private over = false;

  constructor(view: LoadingView, { paint = nextPaint, stepTimeout = 15000 }: Options = {}) {
    this.view = view;
    this.paint = paint;
    this.stepTimeout = stepTimeout;
    this.manager.onProgress = (_item, loaded, total) => {
      if (!this.over) view.progress(loaded / total);
    };
    this.manager.onError = (item) => console.error(`SHUFFLE: couldn't load ${item}`);
    this.manager.onLoad = () => this.end();
    this.manager.itemStart(READY);
  }

  get done(): boolean {
    return this.over;
  }

  /**
   * Runs `steps` in order with a paint between each. All of them are counted
   * before the first runs, so the bar's total never grows. A step that throws
   * or hangs ends loading early; the game carries on with what was built.
   */
  async run(steps: readonly LoadStep[]): Promise<void> {
    for (const [name] of steps) this.manager.itemStart(name);
    for (const [name, step] of steps) {
      if (this.over) return;
      await this.paint();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          step(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`"${name}" took over ${this.stepTimeout} ms`)), this.stepTimeout);
          }),
        ]);
      } catch (error) {
        this.fail(error);
        return;
      } finally {
        clearTimeout(timer);
      }
      this.manager.itemEnd(name);
    }
  }

  /** Call once the game has drawn its first frame; the overlay lifts after that frame is on screen. */
  ready(): void {
    void this.paint().then(() => this.manager.itemEnd(READY));
  }

  fail(error: unknown): void {
    if (this.over) return;
    console.error("SHUFFLE: loading failed", error);
    this.end();
  }

  private end(): void {
    if (this.over) return;
    this.over = true;
    this.view.hide();
  }
}

/** Drives the `#loading` overlay in index.html, and takes it down if start-up throws anywhere. */
export function startLoading(root: HTMLElement): Loading {
  const bar = root.querySelector<HTMLElement>("[role=progressbar]")!;
  const fill = root.querySelector<HTMLElement>(".fill")!;
  const loading = new Loading({
    progress(fraction) {
      fill.style.transform = `scaleX(${fraction})`;
      bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    },
    hide() {
      root.classList.add("done");
      setTimeout(() => root.remove(), 600);
    },
  });
  const crash = (e: ErrorEvent | PromiseRejectionEvent) => loading.fail("reason" in e ? e.reason : (e.error ?? e.message));
  addEventListener("error", crash);
  addEventListener("unhandledrejection", crash);
  return loading;
}
