import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { V2Config } from "./config.ts";
import { publicError, asV2Error, V2Error } from "./errors.ts";
import type { TurnCoordinator, RequestBody } from "./coordinator.ts";
import { redact } from "./redaction.ts";
import type { PersistentImageCache } from "./images.ts";
import type { TlsUnavailableError } from "./errors.ts";

export interface ApiDependencies {
  config: V2Config;
  coordinator: TurnCoordinator;
  images?: PersistentImageCache;
  startedAt?: number;
  transportReady?: () => boolean;
  transportError?: () => TlsUnavailableError | null;
  credentialError?: { code?: string } | null;
}

const MODELS = ["gpt-5.6-thinking", "gpt-5.6-pro", "gpt-5.5-thinking", "gpt-5.5-pro", "gpt-5.3", "gpt-5.3-mini", "o3"];

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(text));
  res.end(text);
}

function sse(res: ServerResponse, value: unknown): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function chunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return { id, object: "chat.completion.chunk", created, model, system_fingerprint: null, choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }] };
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<RequestBody> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const part of req) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    total += buffer.byteLength;
    if (total > maxBytes) throw new V2Error("Request body is too large.", { category: "invalid_request", status: 413, code: "PAYLOAD_TOO_LARGE" });
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch (error) { throw new V2Error("Request body must be valid JSON.", { category: "invalid_request", status: 400, code: "INVALID_JSON", cause: error }); }
}

function modelId(body: RequestBody): string {
  return String(body.model || "gpt-5.6-thinking").split("/").pop() || "gpt-5.6-thinking";
}

function estimatedTokens(value: string): number { return Math.ceil(value.length / 4); }

export function createHttpServer(deps: ApiDependencies) {
  const startedAt = deps.startedAt || Date.now();
  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const method = req.method || "GET";
    try {
      if (method === "GET" && url.pathname === "/healthz") {
        jsonResponse(res, 200, { ok: true, service: "chatgpt-web-v2", version: 1, uptime_ms: Date.now() - startedAt, health: deps.coordinator.health });
        return;
      }
      if (method === "GET" && url.pathname === "/readyz") {
        const tlsReady = deps.transportReady ? deps.transportReady() : true;
        const tlsError = deps.transportError?.();
        const credentialReady = !deps.credentialError;
        const ready = tlsReady && credentialReady && Boolean(deps.config.sessionCookie) && deps.coordinator.health.state !== "authentication_invalid" && deps.coordinator.health.state !== "sentinel_blocked";
        jsonResponse(res, ready ? 200 : 503, { ready, credentialConfigured: Boolean(deps.config.sessionCookie), credentialStore: credentialReady ? "ready" : { state: "unavailable", code: deps.credentialError?.code || "CREDENTIAL_STORE_UNAVAILABLE" }, tls: tlsReady ? "ready" : { state: "unavailable", code: tlsError?.code || "TLS_UNAVAILABLE" }, health: deps.coordinator.health });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/models") {
        jsonResponse(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", created: Math.floor(startedAt / 1000), owned_by: "chatgpt-web-v2" })) });
        return;
      }
      if (method === "GET" && url.pathname.startsWith("/v1/chatgpt-web/image/") && deps.images) {
        const id = url.pathname.split("/").pop()!;
        const cached = deps.images.get(id);
        if (!cached) { jsonResponse(res, 404, { error: { message: "Image not found or expired.", type: "not_found", code: "IMAGE_NOT_FOUND" } }); return; }
        res.statusCode = 200;
        res.setHeader("content-type", cached.metadata.mimeType);
        res.setHeader("cache-control", "private, max-age=1800");
        res.end(cached.data);
        return;
      }
      if (method !== "POST" || url.pathname !== "/v1/chat/completions") {
        jsonResponse(res, 404, { error: { message: "Not found.", type: "invalid_request", code: "NOT_FOUND" } });
        return;
      }
      const body = await readJson(req, deps.config.maxBodyBytes);
      const stream = body.stream === true;
      const id = `chatcmpl-cgpt-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const created = Math.floor(Date.now() / 1000);
      const model = modelId(body);
      const controller = new AbortController();
      const onClose = () => { if (!res.writableEnded) controller.abort(new DOMException("Client disconnected", "AbortError")); };
      req.once("aborted", onClose);
      res.once("close", onClose);
      if (stream) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("cache-control", "no-cache, no-transform");
        res.setHeader("connection", "keep-alive");
        res.setHeader("x-accel-buffering", "no");
        sse(res, chunk(id, created, model, { role: "assistant" }));
        let answer = "";
        let reasoning = "";
        let finished = false;
        try {
          for await (const event of deps.coordinator.events(body, controller.signal)) {
            if (controller.signal.aborted) throw new DOMException("Request cancelled", "AbortError");
            if (event.type === "heartbeat") { res.write(": heartbeat\n\n"); continue; }
            if (event.type === "text_delta" && event.delta) { answer += event.delta; sse(res, chunk(id, created, model, { content: event.delta })); continue; }
            if (event.type === "reasoning_delta" && event.reasoning && deps.config.reasoningEnabled) { reasoning += event.reasoning; sse(res, chunk(id, created, model, { reasoning_content: event.reasoning })); continue; }
            if (event.type === "error") {
              sse(res, { error: { message: event.error?.message || "Upstream stream error.", type: event.error?.category || "upstream_error", code: event.error?.code || "CHATGPT_STREAM_ERROR" } });
              continue;
            }
            if (event.type === "done") { finished = true; }
          }
          if (controller.signal.aborted || !finished) throw new DOMException("Request cancelled", "AbortError");
          sse(res, chunk(id, created, model, {}, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (error) {
          if (!res.writableEnded && !(res as any).destroyed) {
            const mapped = publicError(error);
            try {
              sse(res, { error: mapped.body.error });
              res.write("data: [DONE]\n\n");
              res.end();
            } catch {
              // Client cancellation can close the socket while the upstream task unwinds.
            }
          }
        } finally {
          req.off("aborted", onClose);
          res.off("close", onClose);
        }
        return;
      }
      let answer = "";
      let reasoning = "";
      let conversationId: string | null = null;
      let messageId: string | null = null;
      let finished = false;
      try {
        for await (const event of deps.coordinator.events(body, controller.signal)) {
          if (event.type === "text_delta" && event.delta) answer += event.delta;
          if (event.type === "reasoning_delta" && event.reasoning) reasoning += event.reasoning;
          if (event.conversationId) conversationId = event.conversationId;
          if (event.messageId) messageId = event.messageId;
          if (event.type === "done") finished = true;
          if (event.type === "error") throw new V2Error(event.error?.message || "ChatGPT stream failed.", { category: "upstream", status: 502, code: event.error?.code || "CHATGPT_STREAM_ERROR" });
        }
        if (!finished) throw new V2Error("ChatGPT returned no final answer.", { category: "upstream", status: 502, code: "EMPTY_UPSTREAM_RESPONSE" });
      } catch (error) {
        const mapped = publicError(error);
        jsonResponse(res, mapped.status, mapped.body);
        return;
      }
      const prompt = JSON.stringify(body.messages || []);
      jsonResponse(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        system_fingerprint: null,
        choices: [{ index: 0, message: { role: "assistant", content: answer, ...(deps.config.reasoningEnabled && reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: estimatedTokens(prompt), completion_tokens: estimatedTokens(answer), total_tokens: estimatedTokens(prompt) + estimatedTokens(answer) },
        ...(conversationId ? { x_chatgpt_conversation_id: conversationId } : {}),
        ...(messageId ? { x_chatgpt_message_id: messageId } : {}),
      });
    } catch (error) {
      const mapped = publicError(error);
      if (!res.headersSent) jsonResponse(res, mapped.status, mapped.body);
      else res.end();
    }
  });
}
