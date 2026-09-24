import assert from "node:assert/strict";
import { test } from "node:test";
import { Loading, type LoadStep } from "./loading.ts";

function harness(stepTimeout?: number) {
  const seen: number[] = [];
  let hides = 0;
  const loading = new Loading(
    {
      progress: (f) => seen.push(f),
      hide: () => hides++,
    },
    { paint: () => Promise.resolve(), stepTimeout },
  );
  return { loading, seen, hides: () => hides };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("the bar fills in fixed steps, then lifts after the first frame", async () => {
  const { loading, seen, hides } = harness();
  const ran: string[] = [];
  const steps: LoadStep[] = ["a", "b", "c"].map((n) => [n, () => void ran.push(n)] as const);
  await loading.run(steps);
  assert.deepEqual(ran, ["a", "b", "c"]);
  assert.deepEqual(seen, [1 / 4, 2 / 4, 3 / 4]);
  assert.equal(hides(), 0, "still up until the first frame is drawn");
  loading.ready();
  await settle();
  assert.deepEqual(seen, [1 / 4, 2 / 4, 3 / 4, 1]);
  assert.equal(hides(), 1);
  assert.ok(loading.done);
});

test("async steps finish before the next one starts", async () => {
  const { loading } = harness();
  const order: string[] = [];
  await loading.run([
    ["slow", () => new Promise<void>((r) => setTimeout(() => (order.push("slow"), r()), 5))],
    ["next", () => void order.push("next")],
  ]);
  assert.deepEqual(order, ["slow", "next"]);
});

test("a failing step logs, lifts the overlay, and skips the rest", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const { loading, hides } = harness();
  let after = false;
  await loading.run([
    [
      "boom",
      () => {
        throw new Error("no WebGL");
      },
    ],
    ["after", () => void (after = true)],
  ]);
  assert.equal(after, false);
  assert.equal(hides(), 1);
  assert.equal(errors.mock.callCount(), 1);
  loading.ready();
  loading.fail(new Error("again"));
  await settle();
  assert.equal(hides(), 1, "hidden once");
  assert.equal(errors.mock.callCount(), 1, "later failures are ignored");
});

test("a step that never settles times out instead of blocking forever", async (t) => {
  t.mock.method(console, "error", () => {});
  const { loading, hides } = harness(20);
  await loading.run([["shaders", () => new Promise(() => {})]]);
  assert.equal(hides(), 1);
});

test("URL loaders on the shared manager join the same bar", async () => {
  const { loading, seen } = harness();
  loading.manager.itemStart("felt.png");
  await loading.run([["table", () => {}]]);
  loading.manager.itemEnd("felt.png");
  assert.deepEqual(seen, [1 / 3, 2 / 3]);
});
