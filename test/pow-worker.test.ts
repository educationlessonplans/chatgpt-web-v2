import test from "node:test";
import assert from "node:assert/strict";
import { PowWorkerPool } from "../src/pow.ts";

test("bounded PoW worker pool preserves deterministic vectors off the main loop", async () => {
  const pool = new PowWorkerPool(1);
  const options = { config: ["fixture", "value", 0, 0], seed: "fixture-seed", target: "f", prefix: "gAAAAAC" as const, maxIterations: 10 };
  const first = await pool.solve(options);
  const second = await pool.solve(options);
  assert.deepEqual(first, second);
  assert.equal(first.token.startsWith("gAAAAAC"), true);
  await pool.close();
});

test("PoW worker cancellation is bounded and does not require a replay", async () => {
  const pool = new PowWorkerPool(1);
  const controller = new AbortController();
  const pending = pool.solve({ config: ["fixture", "value", 0, 0], seed: "fixture-seed", target: "000000", prefix: "gAAAAAB", maxIterations: 500_000 }, controller.signal, 30_000);
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
  await pool.close();
});
