import test from "node:test";
import assert from "node:assert/strict";
import { conversationEvents, parseSse, classifyMessage } from "../src/sse.ts";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const item of iter) out.push(item); return out; }

test("SSE parser handles comments, multiline data, done and malformed records", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": keepalive\n\nevent: message\ndata: {\"a\":\n"));
      controller.enqueue(new TextEncoder().encode("data:1}\n\ndata: [DONE]\n\n"));
      controller.close();
    },
  });
  const events = await collect(parseSse(body));
  assert.equal(events[0].kind, "heartbeat");
  assert.equal(events[1].kind, "event");
  assert.equal((events[1].data as any).a, 1);
  assert.equal(events[2].kind, "done");

  async function* malformed() { yield "data: {not-json}\n\n"; }
  const bad = await collect(parseSse(malformed()));
  assert.equal(bad[0].kind, "malformed");
  assert.match(bad[0].error || "", /Malformed/);
});

test("reasoning classification only exposes explicitly labeled summaries", () => {
  const thought = { id: "m-thought", author: { role: "assistant" }, content: { content_type: "thoughts", parts: ["private-looking"] } };
  const ordinary = { id: "m-text", author: { role: "assistant" }, content: { content_type: "text", parts: ["answer"] } };
  assert.deepEqual(classifyMessage(thought, false), []);
  assert.equal(classifyMessage(thought, true)[0].type, "reasoning_delta");
  assert.equal(classifyMessage(ordinary, true)[0].type, "text_delta");
});

test("conversation event pipeline converges text, handoff and reasoning", async () => {
  const sse = [
    'data: {"conversation_id":"conv-fixture"}\n\n',
    'data: {"type":"resume_conversation_token","token":"resume-fixture"}\n\n',
    'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hel"]},"status":"in_progress"}}\n\n',
    'data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hello"]},"status":"in_progress"}}\n\n',
    'data: {"message":{"id":"mt","author":{"role":"assistant"},"content":{"content_type":"thoughts","parts":["summary"]},"status":"in_progress"}}\n\n',
    'event: handoff\ndata: {"type":"stream_handoff"}\n\n',
    'data: [DONE]\n\n',
  ].join("");
  const events = await collect(conversationEvents(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), undefined, true));
  assert.equal(events.some((event) => event.type === "conversation" && event.conversationId === "conv-fixture"), true);
  assert.equal(events.some((event) => event.type === "text_delta" && event.delta === "Hel"), true);
  assert.equal(events.some((event) => event.type === "reasoning_delta" && event.reasoning === "summary"), true);
  assert.equal(events.some((event) => event.type === "handoff" && event.resumeToken === "resume-fixture"), true);
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  assert.equal(done.answer, "Hello");
});

test("conversation cancellation cancels a pending reader and never synthesizes a done event", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull() { await new Promise(() => undefined); },
    cancel() { cancelled = true; },
  });
  const controller = new AbortController();
  const pending = collect(conversationEvents(body, controller.signal));
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const events = await pending;
  assert.equal(cancelled, true);
  assert.equal(events.some((event) => event.type === "done"), false);
});
