import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { MockTransport, response, streamResponse } from "../src/transport.ts";
import { ConversationClient } from "../src/conversation.ts";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const item of iter) out.push(item); return out; }

test("handoff resume tries bounded offsets and converges through the same event pipeline", async () => {
  const config = loadConfig({ CHATGPT_WEB_V2_UPSTREAM_BASE_URL: "https://fixture.invalid", CHATGPT_WEB_V2_LOG_LEVEL: "silent" });
  const transport = new MockTransport(async (request) => {
    if (request.url.endsWith("/backend-api/f/conversation")) return streamResponse(200, 'data: {"conversation_id":"conv-fixture"}\n\ndata: {"type":"resume_conversation_token","token":"resume-fixture"}\n\nevent: handoff\ndata: {"type":"stream_handoff"}\n\ndata: [DONE]\n\n');
    if (request.url.endsWith("/conversation/resume")) {
      const offset = JSON.parse(String(request.body)).offset;
      if (offset === 0) return response(404, {});
      assert.equal(offset, 1);
      return streamResponse(200, 'data: {"message":{"id":"msg-resumed","author":{"role":"assistant"},"content":{"content_type":"text","parts":["resumed answer"]},"status":"finished_successfully"}}\n\ndata: [DONE]\n\n');
    }
    throw new Error(`unexpected URL ${request.url}`);
  });
  const client = new ConversationClient({ config, transport });
  const events = await collect(client.send({
    session: { accessToken: "fixture-access-token", accountId: "fixture-account", expiresAt: Date.now() + 10_000, cookie: "__Secure-next-auth.session-token=fixture-cookie" },
    model: "gpt-5.6-thinking",
    body: { messages: [{ role: "user", content: "fixture prompt" }] },
    state: { accountKeyHash: "fixture", sessionKey: "hermes-one", conversationId: null, parentMessageId: null, modelSlug: null, turnState: "idle", lastInputHash: null, lastMessageId: null, handoffToken: null, uncertainSince: null, createdAt: 0, updatedAt: 0, version: 1 },
    sentinel: { token: "fixture-sentinel" },
  }));
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(events.at(-1)?.answer, "resumed answer");
  assert.equal(transport.requests.filter((request) => request.url.endsWith("/conversation/resume")).length, 2);
});

test("handoff resume failure is uncertain and is never presented as a replayable turn", async () => {
  const config = loadConfig({ CHATGPT_WEB_V2_UPSTREAM_BASE_URL: "https://fixture.invalid", CHATGPT_WEB_V2_LOG_LEVEL: "silent" });
  const transport = new MockTransport(async (request) => {
    if (request.url.endsWith("/backend-api/f/conversation")) return streamResponse(200, 'data: {"conversation_id":"conv-fixture"}\n\ndata: {"type":"resume_conversation_token","token":"resume-fixture"}\n\nevent: handoff\ndata: {"type":"stream_handoff"}\n\ndata: [DONE]\n\n');
    if (request.url.endsWith("/conversation/resume")) return response(500, { error: "fixture failure" });
    throw new Error(`unexpected URL ${request.url}`);
  });
  const client = new ConversationClient({ config, transport });
  await assert.rejects(async () => {
    for await (const _event of client.send({
      session: { accessToken: "fixture-access-token", accountId: "fixture-account", expiresAt: Date.now() + 10_000, cookie: "__Secure-next-auth.session-token=fixture-cookie" },
      model: "gpt-5.6-thinking",
      body: { messages: [{ role: "user", content: "fixture prompt" }] },
      state: { accountKeyHash: "fixture", sessionKey: "hermes-one", conversationId: null, parentMessageId: null, modelSlug: null, turnState: "idle", lastInputHash: null, lastMessageId: null, handoffToken: null, uncertainSince: null, createdAt: 0, updatedAt: 0, version: 1 },
      sentinel: { token: "fixture-sentinel" },
    })) { /* consume */ }
  }, (error: any) => error?.code === "UNCERTAIN_TURN");
});
