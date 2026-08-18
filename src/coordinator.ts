import type { V2Config } from "./config.ts";
import { SessionAuthenticator } from "./auth.ts";
import { AccountAdmission, AsyncMutex } from "./admission.ts";
import { ConversationClient, resolveModel } from "./conversation.ts";
import { CancellationError, UncertainTurnError, V2Error, asV2Error } from "./errors.ts";
import type { ConversationInternalEvent } from "./sse.ts";
import { SessionStore, type SessionState } from "./sessions/store.ts";
import type { SentinelClient } from "./sentinel.ts";
import type { Logger } from "./logger.ts";

export interface CoordinatorDependencies {
  config: V2Config;
  auth: SessionAuthenticator;
  sentinel: SentinelClient;
  conversation: ConversationClient;
  sessions: SessionStore;
  admission: AccountAdmission;
  log: Logger;
}

export interface RequestBody {
  model?: string;
  messages?: unknown[];
  user?: string;
  stream?: boolean;
  reset?: boolean;
  chatgpt_web_v2?: { reset?: boolean; temporary?: boolean };
  [key: string]: any;
}

function stableSessionKey(user: unknown): string {
  if (typeof user !== "string" || !user.trim()) return "anonymous";
  return user.trim().slice(0, 256);
}

function shouldPersistConversation(body: RequestBody): boolean {
  const keyed = typeof body.user === "string" && body.user.trim().length > 0;
  const explicitEphemeral = body.temporary === true || body.persistConversation === false || body.chatgpt_web_v2?.temporary === true;
  return !explicitEphemeral && keyed;
}

function ensureMessages(body: RequestBody): unknown[] {
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new V2Error("Missing or empty messages array.", { category: "invalid_request", status: 400, code: "INVALID_MESSAGES" });
  return body.messages;
}

/** Coordinates auth, Sentinel, durable session state, queueing and the single event pipeline. */
export class TurnCoordinator {
  private readonly mutexes = new Map<string, AsyncMutex>();

  private readonly deps: CoordinatorDependencies;
  constructor(deps: CoordinatorDependencies) { this.deps = deps; }

  get health() { return this.deps.admission.snapshot(); }

  async *events(body: RequestBody, signal?: AbortSignal): AsyncGenerator<ConversationInternalEvent> {
    const messages = ensureMessages(body);
    const sessionKey = stableSessionKey(body.user);
    let mutex = this.mutexes.get(sessionKey);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.mutexes.set(sessionKey, mutex);
    }
    const releaseMutex = await mutex.acquire(signal);
    let releaseAdmission: (() => void) | null = null;
    let postStarted = false;
    let completed = false;
    let conversationId: string | null = null;
    let messageId: string | null = null;
    let persistConversation = false;
    try {
      if (body.reset || body.chatgpt_web_v2?.reset) {
        const reset = this.deps.sessions.reset(sessionKey);
        this.deps.log.info("session.reset", { session: sessionKey, version: reset.version });
      }
      releaseAdmission = await this.deps.admission.acquire(signal, this.deps.config.queueTimeoutMs);
      const state = this.deps.sessions.getOrCreate(sessionKey);
      const session = await this.deps.auth.exchange(this.deps.auth.currentCookie || this.deps.config.sessionCookie, signal);
      if (state.turnState === "uncertain" || state.turnState === "reconciling") {
        this.deps.sessions.markReconciling(sessionKey);
        const reconciled = await this.deps.conversation.reconcile(state, session, signal);
        if (!reconciled?.finished) {
          this.deps.sessions.markUncertain(sessionKey, "RECONCILIATION_PENDING");
          throw new UncertainTurnError("Previous ChatGPT turn remains uncertain; use reset before sending a new turn.");
        }
        completed = true;
        conversationId = reconciled.conversationId;
        messageId = reconciled.messageId;
        yield { type: "text_delta", delta: reconciled.text, answer: reconciled.text, conversationId, messageId, metadata: reconciled.metadata };
        yield { type: "done", answer: reconciled.text, conversationId, messageId, metadata: reconciled.metadata };
        this.deps.sessions.markCompleted(sessionKey, { conversationId, parentMessageId: messageId, modelSlug: state.modelSlug || String(body.model || "gpt-5.6-thinking"), messageId, input: messages });
        this.deps.admission.recordSuccess();
        return;
      }
      const model = resolveModel(String(body.model || "gpt-5.6-thinking"), body);
      persistConversation = shouldPersistConversation(body);
      const sentinel = await this.deps.sentinel.prepare(session, signal);
      const stored = this.deps.sessions.getOrCreate(sessionKey);
      const inFlight = persistConversation
        ? this.deps.sessions.markInFlight(sessionKey, messages, model.slug)
        : { ...stored, conversationId: null, parentMessageId: null, modelSlug: model.slug, turnState: "in_flight" as const };
      postStarted = true;
      this.deps.log.info("conversation.start", { session: sessionKey, model: model.slug, continuation: Boolean(inFlight.conversationId) });
      for await (const event of this.deps.conversation.send({ session, model: model.slug, body: { ...body, messages }, state: inFlight, sentinel, signal, reasoningEnabled: this.deps.config.reasoningEnabled, persistConversation: shouldPersistConversation(body) })) {
        if (event.conversationId) conversationId = event.conversationId;
        if (event.messageId) messageId = event.messageId;
        if (event.type === "error") {
          yield event;
          this.deps.sessions.markUncertain(sessionKey, event.error?.code || "upstream_stream_error");
          throw new V2Error(event.error?.message || "ChatGPT stream failed.", { category: "upstream", status: 502, code: event.error?.code || "CHATGPT_STREAM_ERROR", postAttempted: true });
        }
        if (event.type === "done") {
          completed = true;
          conversationId ||= inFlight.conversationId;
          if (persistConversation) {
            this.deps.sessions.markCompleted(sessionKey, { conversationId, parentMessageId: messageId || inFlight.parentMessageId, modelSlug: model.slug, messageId, input: messages });
          }
        }
        yield event;
      }
      if (!completed) {
        if (signal?.aborted) throw new CancellationError("Request cancelled after the ChatGPT turn was sent.", undefined, true);
        throw new UncertainTurnError("ChatGPT stream ended without a final event.");
      }
      this.deps.admission.recordSuccess();
    } catch (error) {
      const normalized = asV2Error(error);
      if (postStarted && !completed && (normalized.postAttempted || normalized.category === "uncertain_turn")) {
        this.deps.sessions.markUncertain(sessionKey, normalized.code);
      } else if (postStarted && !completed && persistConversation) this.deps.sessions.markIdle(sessionKey);
      if (normalized.category === "authentication") this.deps.admission.recordFailure("authentication", normalized.code);
      else if (normalized.category === "sentinel") this.deps.admission.recordFailure("sentinel", normalized.code);
      else if (normalized.category === "rate_limit") this.deps.admission.recordFailure("rate_limit", normalized.code);
      else if (normalized.category === "transport" || normalized.category === "timeout") this.deps.admission.recordFailure("transport", normalized.code);
      this.deps.log.warn("conversation.failed", { session: sessionKey, code: normalized.code, category: normalized.category });
      throw normalized;
    } finally {
      releaseAdmission?.();
      releaseMutex();
    }
  }

  reset(user: unknown): SessionState {
    return this.deps.sessions.reset(stableSessionKey(user));
  }
}

export { stableSessionKey };
