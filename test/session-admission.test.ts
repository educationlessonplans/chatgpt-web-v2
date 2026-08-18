import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store.ts";
import { AccountAdmission, AsyncMutex } from "../src/admission.ts";

test("SQLite session state persists continuation and reset metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-session-"));
  const path = join(root, "sessions.sqlite");
  const first = new SessionStore(path, "fixture-account");
  first.markInFlight("hermes-one", [{ role: "user", content: "first" }], "gpt-5-6-thinking");
  first.markCompleted("hermes-one", { conversationId: "conv-one", parentMessageId: "msg-one", modelSlug: "gpt-5-6-thinking", messageId: "msg-one", input: [{ role: "user", content: "first" }] });
  const version = first.get("hermes-one")!.version;
  first.close();
  const restarted = new SessionStore(path, "fixture-account");
  const state = restarted.get("hermes-one")!;
  assert.equal(state.conversationId, "conv-one");
  assert.equal(state.parentMessageId, "msg-one");
  assert.equal(state.turnState, "idle");
  const reset = restarted.reset("hermes-one");
  assert.equal(reset.conversationId, null);
  assert.equal(reset.version > version, true);
  restarted.close();
  rmSync(root, { recursive: true, force: true });
});

test("three Hermes identities are isolated and same-session mutex serializes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-admission-"));
  const store = new SessionStore(join(root, "sessions.sqlite"), "fixture-account");
  for (const key of ["hermes-one", "hermes-two", "hermes-three"]) store.markCompleted(key, { conversationId: `conv-${key}`, parentMessageId: `msg-${key}`, modelSlug: "fixture", messageId: `msg-${key}`, input: [key] });
  assert.deepEqual(store.list().map((item) => item.sessionKey).sort(), ["hermes-one", "hermes-three", "hermes-two"]);
  const mutex = new AsyncMutex();
  const first = await mutex.acquire();
  let secondAcquired = false;
  const second = mutex.acquire().then((release) => { secondAcquired = true; release(); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondAcquired, false);
  first();
  await second;
  assert.equal(secondAcquired, true);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("global admission enforces bounded concurrency and queue deadlines", async () => {
  const admission = new AccountAdmission(2, 1, 25);
  const releaseA = await admission.acquire();
  const releaseB = await admission.acquire();
  const queued = admission.acquire();
  assert.equal(admission.activeCount, 2);
  releaseA();
  const releaseC = await queued;
  assert.equal(admission.activeCount, 2);
  releaseB();
  releaseC();
  assert.equal(admission.activeCount, 0);
  const held = await admission.acquire();
  const held2 = await admission.acquire();
  const timeout = admission.acquire();
  await assert.rejects(timeout, /queue deadline|queue/i);
  held();
  held2();
});

test("cooldown blocks new admission until health recovers", async () => {
  let now = 1000;
  const admission = new AccountAdmission(1, 2, 20, () => now);
  admission.setHealth("cooling_down", 10, "fixture");
  const queued = admission.acquire();
  now += 10;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const release = await queued;
  assert.equal(admission.activeCount, 1);
  release();
});

test("uncertain state is explicit and is not implicitly cleared", () => {
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-uncertain-"));
  const store = new SessionStore(join(root, "sessions.sqlite"), "fixture-account");
  store.markInFlight("hermes-one", ["turn"], "fixture");
  store.markUncertain("hermes-one", "TRANSPORT_ERROR");
  assert.equal(store.get("hermes-one")!.turnState, "uncertain");
  assert.equal(store.get("hermes-one")!.handoffToken, "TRANSPORT_ERROR");
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("cancelled session mutex waiter does not poison subsequent turns", async () => {
  const mutex = new AsyncMutex();
  const release = await mutex.acquire();
  const controller = new AbortController();
  const waiting = mutex.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  release();
  const next = await mutex.acquire();
  next();
});
