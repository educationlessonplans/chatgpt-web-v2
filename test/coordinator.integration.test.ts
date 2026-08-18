import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { MockTransport, response, streamResponse } from "../src/transport.ts";
import { SessionAuthenticator } from "../src/auth.ts";
import { DplDiscovery, SentinelClient } from "../src/sentinel.ts";
import { ConversationClient } from "../src/conversation.ts";
import { SessionStore } from "../src/sessions/store.ts";
import { AccountAdmission } from "../src/admission.ts";
import { createLogger } from "../src/logger.ts";
import { TurnCoordinator } from "../src/coordinator.ts";

function fixtureService(handler: (request: any) => Promise<any> | any, maxConcurrency = 1) {
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-coordinator-"));
  const config = loadConfig({ CHATGPT_SESSION_COOKIE: "fixture-cookie", CHATGPT_WEB_V2_DATA_DIR: root, CHATGPT_WEB_V2_MAX_CONCURRENCY: String(maxConcurrency), CHATGPT_WEB_V2_UPSTREAM_BASE_URL: "https://fixture.invalid", CHATGPT_WEB_V2_LOG_LEVEL: "silent" });
  const transport = new MockTransport(handler);
  const logger = createLogger("silent");
  const sessions = new SessionStore(join(root, "sessions.sqlite"), config.accountKey);
  const auth = new SessionAuthenticator({ baseUrl: config.upstreamBaseUrl, transport, log: logger });
  const dpl = new DplDiscovery({ baseUrl: config.upstreamBaseUrl, fallbackClientVersion: config.clientVersion, transport });
  const sentinel = new SentinelClient(config, transport, dpl);
  const conversation = new ConversationClient({ config, transport });
  const admission = new AccountAdmission(config.maxConcurrency, config.queueMax, config.queueTimeoutMs);
  const coordinator = new TurnCoordinator({ config, auth, sentinel, conversation, sessions, admission, log: logger });
  return { root, config, transport, sessions, coordinator };
}

function fixtureHandlerFactory(onConversation?: (body: any, count: number) => void, options: { failPost?: boolean; delayMs?: number } = {}) {
  let conversationCount = 0;
  return async (request: any) => {
    if (request.url.endsWith("/api/auth/session")) return response(200, { accessToken: "fixture-access-token", expires: new Date(Date.now() + 300_000).toISOString(), user: { id: "fixture-account" } });
    if (request.url === "https://fixture.invalid/") return response(200, '<html data-build="fixture-build"><script src="https://fixture.invalid/webpack-1234567890abcdef.js"></script></html>');
    if (request.url.endsWith("/sentinel/chat-requirements/prepare")) return response(200, { prepare_token: "fixture-prepare" });
    if (request.url.endsWith("/sentinel/chat-requirements")) return response(200, { token: "fixture-sentinel", proofofwork: { required: false }, turnstile: { required: false } });
    if (request.url.endsWith("/backend-api/f/conversation")) {
      conversationCount++;
      if (options.failPost) throw new Error("fixture transport disconnected after POST");
      const body = JSON.parse(String(request.body));
      onConversation?.(body, conversationCount);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const id = `msg-${conversationCount}`;
      const text = `answer-${conversationCount}`;
      return streamResponse(200, [
        `data: {"conversation_id":"conv-fixture"}\n\n`,
        `data: {"message":{"id":"${id}","author":{"role":"assistant"},"content":{"content_type":"text","parts":["${text}"]},"status":"in_progress"}}\n\n`,
        `data: {"message":{"id":"${id}","author":{"role":"assistant"},"content":{"content_type":"text","parts":["${text}"]},"status":"finished_successfully","end_turn":true}}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    }
    if (request.url.includes("/backend-api/conversation/")) return response(404, {});
    throw new Error(`unexpected fixture URL ${request.url}`);
  };
}

async function collectEvents(coordinator: TurnCoordinator, body: any): Promise<any[]> {
  const output: any[] = [];
  for await (const event of coordinator.events(body)) output.push(event);
  return output;
}

test("persistent continuation maps three Hermes identities to independent conversations", async () => {
  const seen: any[] = [];
  const fixture = fixtureService(fixtureHandlerFactory((body) => seen.push(body)));
  for (const user of ["hermes-one", "hermes-two", "hermes-three"]) await collectEvents(fixture.coordinator, { model: "gpt-5.6-thinking", user, messages: [{ role: "user", content: `hello ${user}` }] });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((body) => body.conversation_id), [null, null, null]);
  assert.equal(seen[0].history_and_training_disabled, false);
  assert.equal(seen[0].messages.length, 1);
  assert.equal(seen[0].messages[0].author.role, "user");
  await collectEvents(fixture.coordinator, { model: "gpt-5.6-thinking", user: "hermes-one", messages: [{ role: "user", content: "follow-up" }] });
  assert.equal(seen[3].conversation_id, "conv-fixture");
  assert.equal(seen[3].parent_message_id, "msg-1");
  assert.equal(seen[3].history_and_training_disabled, false);
  assert.equal(seen[3].messages.length, 1);
  assert.equal(seen[3].messages[0].content.parts[0], "follow-up");
  fixture.sessions.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

test("same-session requests serialize while different sessions can run concurrently", async () => {
  let active = 0;
  let peak = 0;
  const fixture = fixtureService(async (request) => {
    if (request.url.endsWith("/api/auth/session")) return response(200, { accessToken: "fixture-access-token", expires: new Date(Date.now() + 300_000).toISOString(), user: { id: "fixture-account" } });
    if (request.url === "https://fixture.invalid/") return response(200, '<html data-build="fixture-build"></html>');
    if (request.url.endsWith("/sentinel/chat-requirements/prepare")) return response(200, { prepare_token: "fixture-prepare" });
    if (request.url.endsWith("/sentinel/chat-requirements")) return response(200, { token: "fixture-sentinel" });
    if (request.url.endsWith("/backend-api/f/conversation")) {
      active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 20)); active--;
      return streamResponse(200, 'data: {"conversation_id":"conv"}\n\ndata: {"message":{"id":"msg","author":{"role":"assistant"},"content":{"content_type":"text","parts":["ok"]},"status":"finished_successfully"}}\n\ndata: [DONE]\n\n');
    }
    throw new Error("unexpected fixture request");
  }, 2);
  await Promise.all([
    collectEvents(fixture.coordinator, { user: "same", messages: [{ role: "user", content: "one" }] }),
    collectEvents(fixture.coordinator, { user: "same", messages: [{ role: "user", content: "two" }] }),
    collectEvents(fixture.coordinator, { user: "other", messages: [{ role: "user", content: "three" }] }),
  ]);
  assert.equal(peak <= 2, true);
  fixture.sessions.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

test("uncertain POST is persisted and never replayed automatically", async () => {
  let posts = 0;
  const fixture = fixtureService(async (request) => {
    if (request.url.endsWith("/api/auth/session")) return response(200, { accessToken: "fixture-access-token", expires: new Date(Date.now() + 300_000).toISOString(), user: { id: "fixture-account" } });
    if (request.url === "https://fixture.invalid/") return response(200, '<html data-build="fixture-build"></html>');
    if (request.url.endsWith("/sentinel/chat-requirements/prepare")) return response(200, { prepare_token: "fixture-prepare" });
    if (request.url.endsWith("/sentinel/chat-requirements")) return response(200, { token: "fixture-sentinel" });
    if (request.url.endsWith("/backend-api/f/conversation")) { posts++; throw new Error("disconnect"); }
    if (request.url.includes("/backend-api/conversation/")) return response(404, {});
    throw new Error("unexpected fixture request");
  });
  await assert.rejects(collectEvents(fixture.coordinator, { user: "uncertain", messages: [{ role: "user", content: "turn" }] }), /uncertain|reconcile/i);
  assert.equal(fixture.sessions.get("uncertain")!.turnState, "uncertain");
  await assert.rejects(collectEvents(fixture.coordinator, { user: "uncertain", messages: [{ role: "user", content: "turn again" }] }), /uncertain|reset/i);
  assert.equal(posts, 1);
  fixture.sessions.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

test("temporary mode is explicit and does not change keyed-session defaults", async () => {
  const seen: any[] = [];
  const fixture = fixtureService(fixtureHandlerFactory((body) => seen.push(body)));
  await collectEvents(fixture.coordinator, { user: "hermes-keyed", messages: [{ role: "user", content: "persistent" }] });
  const before = fixture.sessions.get("hermes-keyed")!;
  await collectEvents(fixture.coordinator, { user: "hermes-keyed", temporary: true, messages: [{ role: "user", content: "ephemeral" }] });
  assert.equal(seen[1].history_and_training_disabled, true);
  assert.equal(seen[1].conversation_id, null);
  assert.equal(seen[1].messages.length, 1);
  const after = fixture.sessions.get("hermes-keyed")!;
  assert.equal(after.conversationId, before.conversationId);
  assert.equal(after.parentMessageId, before.parentMessageId);
  fixture.sessions.close();
  rmSync(fixture.root, { recursive: true, force: true });
});
