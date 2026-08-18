import { randomUUID } from "node:crypto";
import type { V2Config } from "./config.ts";
import { buildOaiHeaders, deriveSessionId, type AuthSession } from "./auth.ts";
import { asV2Error, CancellationError, mapHttpError, UncertainTurnError, V2Error } from "./errors.ts";
import { conversationEvents, type ConversationInternalEvent } from "./sse.ts";
import type { SentinelRequirements } from "./sentinel.ts";
import type { HttpTransport } from "./transport.ts";
import type { SessionState } from "./sessions/store.ts";

const ALIASES: Record<string, string> = {
  "gpt-5.6-pro": "gpt-5-6-pro",
  "gpt-5-6-pro": "gpt-5-6-pro",
  "gpt-5.6-thinking": "gpt-5-6-thinking",
  "gpt-5-6-thinking": "gpt-5-6-thinking",
  "gpt-5.5-pro": "gpt-5-5-pro",
  "gpt-5-5-pro": "gpt-5-5-pro",
  "gpt-5.5-pro-extended": "gpt-5-5-pro-extended",
  "gpt-5-5-pro-extended": "gpt-5-5-pro-extended",
  "gpt-5.5-thinking": "gpt-5-5-thinking",
  "gpt-5-5-thinking": "gpt-5-5-thinking",
  "gpt-5.5": "gpt-5-5",
  "gpt-5.3-instant": "gpt-5-3-instant",
  "gpt-5.3": "gpt-5-3",
  "gpt-5.3-mini": "gpt-5-3-mini",
  o3: "o3",
};

export function resolveModel(model: string, body: Record<string, any> = {}): { slug: string; effort?: "standard" | "extended"; isPro: boolean } {
  const raw = String(model || "gpt-5.6-thinking").split("/").pop()!.toLowerCase();
  const slug = ALIASES[raw] || raw.replace(/\./g, "-");
  const requested = body.providerSpecificData?.thinkingEffort || body.reasoning_effort || body.reasoning?.effort;
  const effort = /^(extended|high|xhigh)$/i.test(String(requested || ""))
    ? "extended"
    : /^(standard|low|medium|minimal)$/i.test(String(requested || ""))
      ? "standard"
      : /pro$|pro-extended$/.test(slug)
        ? (slug.endsWith("extended") ? "extended" : "standard")
        : undefined;
  return { slug, effort, isPro: slug === "gpt-5-6-pro" || slug === "gpt-5-5-pro" || slug === "gpt-5-5-pro-extended" };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part && (part.type === "text" || part.type === "input_text") && typeof part.text === "string")
    .map((part: any) => part.text)
    .join(" ");
}

export interface PreparedMessages {
  systemMsg: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  currentMsg: string;
}

export function prepareMessages(messages: unknown[]): PreparedMessages {
  let systemMsg = "";
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of messages as any[]) {
    const role = item?.role === "developer" ? "system" : String(item?.role || "user");
    const content = textContent(item?.content).trim();
    if (!content) continue;
    if (role === "system") systemMsg += `${systemMsg ? "\n" : ""}${content}`;
    else if (role === "user" || role === "assistant") history.push({ role, content });
  }
  const current = history.at(-1)?.role === "user" ? history.pop()!.content : "";
  return { systemMsg, history, currentMsg: current };
}

export interface ConversationPayloadOptions {
  modelSlug: string;
  messages: unknown[];
  state: SessionState;
  thinkingEffort?: string;
  persistConversation: boolean;
}

export function buildConversationPayload(options: ConversationPayloadOptions): Record<string, unknown> {
  const prepared = prepareMessages(options.messages);
  if (!prepared.currentMsg) throw new V2Error("Empty user message.", { category: "invalid_request", status: 400, code: "EMPTY_USER_MESSAGE" });
  const context: string[] = [];
  if (prepared.systemMsg) context.push(prepared.systemMsg);
  if (!options.state.conversationId && prepared.history.length) {
    context.push(`Prior conversation (for context — answer only the new user message below):\n${prepared.history.map((item) => `${item.role === "assistant" ? "Assistant" : "User"}: ${item.content}`).join("\n\n")}`);
  }
  const upstreamMessages: Array<Record<string, unknown>> = [];
  if (context.length) {
    upstreamMessages.push({
      id: randomUUID(),
      author: { role: "system" },
      content: { content_type: "text", parts: [context.join("\n\n")] },
    });
  }
  upstreamMessages.push({
    id: randomUUID(),
    author: { role: "user" },
    content: { content_type: "text", parts: [prepared.currentMsg] },
  });
  const parent = options.state.parentMessageId || randomUUID();
  return {
    action: "next",
    messages: upstreamMessages,
    model: options.modelSlug,
    conversation_id: options.state.conversationId,
    parent_message_id: parent,
    timezone_offset_min: -new Date().getTimezoneOffset(),
    history_and_training_disabled: options.persistConversation === false,
    suggestions: [],
    websocket_request_id: randomUUID(),
    conversation_mode: { kind: "primary_assistant" },
    supports_buffering: true,
    force_parallel_switch: "auto",
    paragen_cot_summary_display_override: "allow",
    ...(options.thinkingEffort ? { thinking_effort: options.thinkingEffort } : {}),
  };
}

export interface ConversationClientOptions {
  config: Pick<V2Config, "upstreamBaseUrl" | "userAgent" | "clientVersion" | "clientBuildNumber" | "requestTimeoutMs" | "handoffTimeoutMs" | "pollIntervalMs" | "pollTimeoutMs">;
  transport: HttpTransport;
  log?: { debug?: (event: string, fields?: Record<string, unknown>) => void; warn?: (event: string, fields?: Record<string, unknown>) => void };
}

export interface TurnRequest {
  session: AuthSession;
  model: string;
  body: Record<string, any>;
  state: SessionState;
  sentinel: SentinelRequirements;
  signal?: AbortSignal;
  reasoningEnabled?: boolean;
  persistConversation?: boolean;
}

export interface ReconciledTurn {
  conversationId: string;
  messageId: string;
  text: string;
  metadata?: Record<string, unknown>;
  finished?: boolean;
}

async function waitWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); done(); };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function chooseLatestAssistant(detail: any): ReconciledTurn | null {
  const conversationId = String(detail?.conversation_id || "");
  if (!conversationId) return null;
  const candidates: any[] = [];
  for (const node of Object.values(detail?.mapping || {}) as any[]) {
    const message = node?.message;
    if (!message || message.author?.role !== "assistant" || message.metadata?.is_visually_hidden === true) continue;
    const type = String(message.content?.content_type || "").toLowerCase();
    if (type.includes("thought") || type.includes("reasoning")) continue;
    const parts = Array.isArray(message.content?.parts) ? message.content.parts : [];
    const text = parts.map(textContent).join("").trim();
    const messageId = String(message.id || "");
    if (!text || !messageId) continue;
    candidates.push({
      conversationId,
      messageId,
      text,
      metadata: message.metadata,
      finished: message.status === "finished_successfully" && message.end_turn !== false,
      sort: Number(message.update_time || message.create_time || 0),
    });
  }
  candidates.sort((a, b) => Number(b.finished) - Number(a.finished) || b.sort - a.sort);
  return candidates[0] || null;
}

export class ConversationClient {
  private readonly options: ConversationClientOptions;
  constructor(options: ConversationClientOptions) { this.options = options; }

  async *send(request: TurnRequest): AsyncGenerator<ConversationInternalEvent> {
    const model = resolveModel(request.model, request.body);
    const deviceId = randomUUID();
    const sessionId = deriveSessionId(request.session.cookie);
    const payload = buildConversationPayload({
      modelSlug: model.slug,
      messages: request.body.messages,
      state: request.state,
      thinkingEffort: model.effort,
      persistConversation: request.persistConversation ?? request.body.persistConversation !== false,
    });
    const headers = buildOaiHeaders({
      baseUrl: this.options.config.upstreamBaseUrl,
      userAgent: this.options.config.userAgent,
      clientVersion: this.options.config.clientVersion,
      clientBuildNumber: this.options.config.clientBuildNumber,
      deviceId,
      sessionId,
      cookie: request.session.cookie,
      accessToken: request.session.accessToken,
      accountId: request.session.accountId,
      accept: "text/event-stream",
    });
    headers["Content-Type"] = "application/json";
    headers["x-oai-turn-trace-id"] = randomUUID();
    if (request.sentinel.token) headers["openai-sentinel-chat-requirements-token"] = request.sentinel.token;
    if (request.sentinel.prepare_token) headers["openai-sentinel-chat-requirements-prepare-token"] = request.sentinel.prepare_token;
    if (request.sentinel.proof_token) headers["openai-sentinel-proof-token"] = request.sentinel.proof_token;
    if (request.signal?.aborted) throw new CancellationError();
    let response;
    try {
      response = await this.options.transport.request({
        url: `${this.options.config.upstreamBaseUrl}/backend-api/f/conversation`,
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: request.signal,
        timeoutMs: this.options.config.requestTimeoutMs,
        stream: true,
      });
    } catch (error) {
      // POST was handed to the transport; conservative recovery marks it uncertain and never replays it.
      throw new UncertainTurnError("ChatGPT conversation POST outcome is uncertain; reconcile the conversation before retrying.", error);
    }
    if (response.status >= 400) throw mapHttpError(response.status, `ChatGPT conversation request rejected (HTTP ${response.status}).`);
    if (!response.body) throw new UncertainTurnError("ChatGPT conversation returned no stream body.");

    let handoff = false;
    let handoffToken: string | undefined;
    let conversationId: string | undefined;
    try {
      for await (const event of conversationEvents(response.body, request.signal, request.reasoningEnabled === true)) {
        if (event.conversationId) conversationId = event.conversationId;
        if (event.type === "handoff") {
          handoff = true;
          handoffToken = event.resumeToken;
          yield event;
          continue;
        }
        if (event.type === "done" && handoff) continue;
        yield event;
      }
    } catch (error) {
      if (request.signal?.aborted) throw new CancellationError("Request cancelled while reading the ChatGPT stream.", error, true);
      throw new UncertainTurnError("ChatGPT conversation stream outcome is uncertain; reconcile before retrying.", error);
    }
    if (!handoff || !conversationId || !handoffToken) return;
    let resumed: { events: AsyncGenerator<ConversationInternalEvent> } | null;
    try {
      resumed = await this.resume({ ...request, conversationId, resumeToken: handoffToken, headers }, request.signal);
    } catch (error) {
      if (request.signal?.aborted) throw new CancellationError("Request cancelled while resuming a handed-off turn.", error, true);
      throw new UncertainTurnError("ChatGPT handoff resume outcome is uncertain; reconcile before retrying.", error);
    }
    if (resumed) {
      for await (const event of resumed.events) yield event;
      return;
    }
    let polled: ReconciledTurn | null;
    try {
      polled = await this.poll(conversationId, request, true);
    } catch (error) {
      if (request.signal?.aborted) throw new CancellationError("Request cancelled while reconciling a handed-off turn.", error, true);
      throw new UncertainTurnError("ChatGPT handoff polling outcome is uncertain; reconcile before retrying.", error);
    }
    if (polled?.finished) {
      yield { type: "text_delta", delta: polled.text, answer: polled.text, conversationId: polled.conversationId, messageId: polled.messageId, metadata: polled.metadata };
      yield { type: "done", answer: polled.text, conversationId: polled.conversationId, messageId: polled.messageId, metadata: polled.metadata };
    } else {
      throw new UncertainTurnError("ChatGPT handoff could not be reconciled before the polling deadline.");
    }
  }

  private async resume(request: TurnRequest & { conversationId: string; resumeToken: string; headers: Record<string, string> }, signal?: AbortSignal): Promise<{ events: AsyncGenerator<ConversationInternalEvent> } | null> {
    for (const offset of [0, 1, 2]) {
      if (signal?.aborted) throw new CancellationError();
      const response = await this.options.transport.request({
        url: `${this.options.config.upstreamBaseUrl}/backend-api/f/conversation/resume`,
        method: "POST",
        headers: {
          ...request.headers,
          Accept: "text/event-stream",
          "x-conduit-token": request.resumeToken,
          "X-OpenAI-Target-Path": "/backend-api/f/conversation/resume",
          "X-OpenAI-Target-Route": "/backend-api/f/conversation/resume",
        },
        body: JSON.stringify({ conversation_id: request.conversationId, offset }),
        signal,
        timeoutMs: this.options.config.handoffTimeoutMs,
        stream: true,
      });
      if (signal?.aborted) throw new CancellationError();
      if (response.status === 404) continue;
      if (response.status >= 400) throw mapHttpError(response.status, `ChatGPT handoff resume failed (HTTP ${response.status}).`);
      if (!response.body) continue;
      return { events: conversationEvents(response.body, signal, request.reasoningEnabled === true) };
    }
    return null;
  }

  async poll(conversationId: string, request: TurnRequest, allowLatest = false): Promise<ReconciledTurn | null> {
    const deadline = Date.now() + this.options.config.pollTimeoutMs;
    let latest: ReconciledTurn | null = null;
    while (!request.signal?.aborted && Date.now() < deadline) {
      const response = await this.options.transport.request({
        url: `${this.options.config.upstreamBaseUrl}/backend-api/conversation/${encodeURIComponent(conversationId)}`,
        method: "GET",
        headers: buildOaiHeaders({
          baseUrl: this.options.config.upstreamBaseUrl,
          userAgent: this.options.config.userAgent,
          clientVersion: this.options.config.clientVersion,
          clientBuildNumber: this.options.config.clientBuildNumber,
          deviceId: randomUUID(),
          sessionId: deriveSessionId(request.session.cookie),
          cookie: request.session.cookie,
          accessToken: request.session.accessToken,
          accountId: request.session.accountId,
          accept: "application/json",
        }),
        signal: request.signal,
        timeoutMs: 30_000,
      });
      if ([401, 403, 404].includes(response.status)) return null;
      if (response.status < 400) {
        try {
          const candidate = chooseLatestAssistant(JSON.parse(response.text || "{}"));
          if ((candidate as any)?.finished) return candidate;
          if (candidate) latest = candidate;
        } catch {
          // Polling remains best-effort; do not expose upstream response text.
        }
      }
      const wait = Math.min(this.options.config.pollIntervalMs, Math.max(1, deadline - Date.now()));
      await waitWithSignal(wait, request.signal);
    }
    if (request.signal?.aborted) throw new CancellationError();
    return allowLatest ? latest : null;
  }

  async reconcile(state: SessionState, session: AuthSession, signal?: AbortSignal): Promise<ReconciledTurn | null> {
    if (!state.conversationId) return null;
    return this.poll(state.conversationId, { session, model: state.modelSlug || "gpt-5.6-thinking", body: { messages: [{ role: "user", content: "" }] }, state, sentinel: {}, signal });
  }
}
