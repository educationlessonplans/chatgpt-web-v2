import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer } from "../src/api.ts";
import { PersistentImageCache } from "../src/images.ts";
import { validateToolArguments, parseEmulatedToolCalls } from "../src/tools.ts";
import { loadConfig } from "../src/config.ts";

class FakeRequest extends EventEmitter {
  method: string;
  headers: Record<string, string> = { host: "127.0.0.1" };
  url: string;
  private readonly chunks: Buffer[];
  constructor(body: unknown, method = "POST", url = "/v1/chat/completions") { super(); this.method = method; this.url = url; this.chunks = [Buffer.from(JSON.stringify(body))]; }
  async *[Symbol.asyncIterator]() { for (const chunk of this.chunks) yield chunk; }
}

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  headers: Record<string, string | number> = {};
  chunks: string[] = [];
  setHeader(name: string, value: string | number) { this.headers[name.toLowerCase()] = value; this.headersSent = true; }
  write(value: string) { this.headersSent = true; this.chunks.push(value); return true; }
  end(value?: string | Uint8Array) { if (value) this.chunks.push(typeof value === "string" ? value : new TextDecoder().decode(value)); this.writableEnded = true; this.emit("close"); }
  get text() { return this.chunks.join(""); }
}

async function invoke(server: any, body: unknown, method = "POST", url = "/v1/chat/completions"): Promise<FakeResponse> {
  const request = new FakeRequest(body, method, url);
  const response = new FakeResponse();
  const handler = server.listeners("request")[0];
  await new Promise<void>((resolve) => { response.once("close", () => resolve()); Promise.resolve(handler(request, response)).catch(() => resolve()); });
  return response;
}

test("tool emulation validates exact names and JSON schema", () => {
  const tools: any[] = [{ type: "function", function: { name: "lookup", parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } }, additionalProperties: false } } }];
  assert.deepEqual(validateToolArguments(tools[0], '{"query":"fixture"}'), { query: "fixture" });
  assert.throws(() => validateToolArguments(tools[0], '{"query":2}'), /schema validation/);
  assert.deepEqual(parseEmulatedToolCalls('<tool name="lookup">{"query":"fixture"}</tool>', tools)[0].function.name, "lookup");
  assert.throws(() => parseEmulatedToolCalls('<tool name="missing">{}</tool>', tools), /Unknown tool/);
});

test("persistent image metadata/cache survives a reopen and enforces identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-images-"));
  const db = join(root, "metadata.sqlite");
  const first = new PersistentImageCache(root, 60_000, 1000, db);
  const metadata = first.put(new TextEncoder().encode("fixture-image"), "image/png", { conversationId: "conv-fixture", parentMessageId: "msg-fixture" });
  assert.equal(first.get(metadata.id)!.metadata.conversationId, "conv-fixture");
  first.close();
  const reopened = new PersistentImageCache(root, 60_000, 1000, db);
  const hit = reopened.get(metadata.id)!;
  assert.equal(new TextDecoder().decode(hit.data), "fixture-image");
  assert.equal(hit.metadata.sha256, metadata.sha256);
  reopened.close();
  rmSync(root, { recursive: true, force: true });
});

test("HTTP API emits OpenAI JSON and SSE without assistant prose errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-api-"));
  const config = loadConfig({ CHATGPT_WEB_V2_DATA_DIR: root, CHATGPT_SESSION_COOKIE: "fixture-cookie", CHATGPT_WEB_V2_LOG_LEVEL: "silent" });
  const fakeCoordinator: any = {
    health: { state: "healthy", active: 0, queued: 0, cooldownUntil: 0, lastFailure: null },
    async *events(body: any) {
      if (body.fail) {
        yield { type: "error", error: { message: "structured fixture error", category: "upstream", code: "FIXTURE_ERROR" } };
        return;
      }
      yield { type: "text_delta", delta: "fixture answer", answer: "fixture answer", conversationId: "conv-fixture", messageId: "msg-fixture" };
      yield { type: "done", answer: "fixture answer", conversationId: "conv-fixture", messageId: "msg-fixture" };
    },
  };
  const server = createHttpServer({ config, coordinator: fakeCoordinator });
  const health = await invoke(server, {}, "GET", "/healthz");
  assert.equal(JSON.parse(health.text).ok, true);
  const models = await invoke(server, {}, "GET", "/v1/models");
  assert.equal(JSON.parse(models.text).object, "list");
  const jsonResponse = await invoke(server, { model: "gpt-5.6-thinking", user: "fixture", messages: [{ role: "user", content: "hello" }] });
  const json = JSON.parse(jsonResponse.text);
  assert.equal(json.choices[0].message.content, "fixture answer");
  const streamResult = await invoke(server, { model: "gpt-5.6-thinking", stream: true, messages: [{ role: "user", content: "hello" }] });
  const streamText = streamResult.text;
  assert.match(streamText, /chat\.completion\.chunk/);
  assert.match(streamText, /fixture answer/);
  assert.match(streamText, /data: \[DONE\]/);
  const failed = (await invoke(server, { fail: true, stream: true, messages: [{ role: "user", content: "hello" }] })).text;
  assert.match(failed, /FIXTURE_ERROR|structured fixture error/);
  assert.equal(failed.includes("[Error:"), false);
  rmSync(root, { recursive: true, force: true });
});
