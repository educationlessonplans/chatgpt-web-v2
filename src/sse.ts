export interface SseEvent {
  kind: "event" | "heartbeat" | "done" | "malformed";
  type?: string;
  data?: unknown;
  raw?: string;
  error?: string;
}

function parseData(type: string | undefined, lines: string[]): SseEvent {
  const raw = lines.join("\n").trim();
  if (!raw) return { kind: "heartbeat", type };
  if (raw === "[DONE]") return { kind: "done", type };
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !data.type && type) data.type = type;
    return { kind: "event", type, data, raw };
  } catch (error) {
    return { kind: "malformed", type, raw, error: `Malformed upstream SSE JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function* chunks(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<string> {
  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let resolveAbort: ((result: IteratorResult<Uint8Array>) => void) | null = null;
    const abortResult = signal
      ? new Promise<IteratorResult<Uint8Array>>((resolve) => { resolveAbort = resolve; })
      : null;
    const abort = () => {
      void reader.cancel(signal?.reason).catch(() => undefined);
      resolveAbort?.({ done: true, value: undefined as never });
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const item = abortResult ? await Promise.race([reader.read(), abortResult]) : await reader.read();
        if (item.done) break;
        yield decoder.decode(item.value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
    return;
  }
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    yield typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  }
}

/** Parse SSE without turning comments into assistant deltas; malformed records remain observable. */
export async function* parseSse(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  let buffer = "";
  let eventType: string | undefined;
  let dataLines: string[] = [];
  const flush = (): SseEvent | null => {
    if (!eventType && dataLines.length === 0) return null;
    const event = parseData(eventType, dataLines);
    eventType = undefined;
    dataLines = [];
    return event;
  };
  for await (const chunk of chunks(body, signal)) {
    if (signal?.aborted) return;
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) {
        const event = flush();
        if (event) {
          yield event;
          if (event.kind === "done") return;
        }
      } else if (line.startsWith(":")) {
        yield { kind: "heartbeat", raw: line.slice(1).trim() };
      } else if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
  if (signal?.aborted) return;
  if (buffer.trim()) {
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    else if (buffer.startsWith(":")) yield { kind: "heartbeat", raw: buffer.slice(1).trim() };
  }
  const event = flush();
  if (event) yield event;
}

export interface ConversationInternalEvent {
  type: "text_delta" | "reasoning_delta" | "conversation" | "handoff" | "metadata" | "error" | "heartbeat" | "done";
  delta?: string;
  answer?: string;
  reasoning?: string;
  conversationId?: string;
  messageId?: string;
  resumeToken?: string;
  metadata?: Record<string, unknown>;
  error?: { message: string; code: string; category: string; status?: number };
  imagePointers?: Array<{ pointer: string; messageId?: string }>;
}

function textFromPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const value = part as Record<string, unknown>;
  for (const key of ["text", "content", "summary"]) if (typeof value[key] === "string") return value[key] as string;
  return "";
}

function contentType(message: Record<string, any>): string {
  return typeof message.content?.content_type === "string" ? message.content.content_type.toLowerCase() : "";
}

/** A reasoning event is accepted only when upstream explicitly labels content as thought/reasoning. */
export function classifyMessage(message: unknown, includeReasoning = false): ConversationInternalEvent[] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, any>;
  if (record.author?.role !== "assistant") return [];
  const type = contentType(record);
  const parts = Array.isArray(record.content?.parts) ? record.content.parts : [];
  const text = parts.map(textFromPart).join("");
  if (!text) return [];
  const common = {
    messageId: typeof record.id === "string" ? record.id : undefined,
    metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : undefined,
  };
  if (type.includes("thought") || type.includes("reasoning")) {
    return includeReasoning ? [{ type: "reasoning_delta", reasoning: text, ...common }] : [];
  }
  return [{ type: "text_delta", delta: text, ...common }];
}

function pointerParts(message: any): Array<{ pointer: string; messageId?: string }> {
  const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
  return parts
    .filter((part: any) => part && typeof part === "object" && part.content_type === "image_asset_pointer" && typeof part.asset_pointer === "string")
    .map((part: any) => ({ pointer: part.asset_pointer, messageId: typeof message.id === "string" ? message.id : undefined }));
}

/** Convert audited ChatGPT SSE records to one internal event stream used by both API modes. */
export async function* conversationEvents(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | AsyncIterable<string>, signal?: AbortSignal, includeReasoning = false): AsyncGenerator<ConversationInternalEvent> {
  let answer = "";
  let reasoning = "";
  let conversationId: string | undefined;
  let messageId: string | undefined;
  let resumeToken: string | undefined;
  const pointers = new Map<string, { pointer: string; messageId?: string }>();
  for await (const event of parseSse(body, signal)) {
    if (event.kind === "heartbeat") {
      yield { type: "heartbeat" };
      continue;
    }
    if (event.kind === "malformed") {
      yield {
        type: "error",
        error: { message: event.error || "Malformed upstream SSE.", code: "MALFORMED_SSE", category: "upstream" },
      };
      return;
    }
    if (event.kind === "done") break;
    const payload = event.data as Record<string, any> | undefined;
    if (!payload) continue;
    if (typeof payload.conversation_id === "string") {
      conversationId = payload.conversation_id;
      yield { type: "conversation", conversationId };
    }
    if (payload.type === "resume_conversation_token" && typeof payload.token === "string") {
      resumeToken = payload.token;
      continue;
    }
    if (payload.type === "stream_handoff") {
      yield { type: "handoff", conversationId, resumeToken };
      continue;
    }
    if (payload.type === "server_ste_metadata" && payload.metadata && typeof payload.metadata === "object") {
      yield { type: "metadata", metadata: payload.metadata };
    }
    if (payload.error) {
      const message = typeof payload.error === "string" ? payload.error : payload.error.message || "ChatGPT stream error.";
      yield { type: "error", error: { message, code: "CHATGPT_STREAM_ERROR", category: "upstream" }, conversationId };
      return;
    }
    const message = payload.message;
    if (!message) continue;
    const records = classifyMessage(message, includeReasoning);
    for (const record of records) {
      if (record.messageId) messageId = record.messageId;
      if (record.type === "text_delta" && record.delta) {
        const delta = record.delta.length >= answer.length && record.delta.startsWith(answer)
          ? record.delta.slice(answer.length)
          : record.delta;
        if (!delta) continue;
        answer = record.delta.length >= answer.length && record.delta.startsWith(answer) ? record.delta : answer + record.delta;
        yield { ...record, delta, answer, conversationId };
      } else if (record.type === "reasoning_delta" && record.reasoning) {
        reasoning += record.reasoning;
        yield { ...record, reasoning: record.reasoning, conversationId };
      }
    }
    for (const pointer of pointerParts(message)) pointers.set(pointer.pointer, pointer);
  }
  if (signal?.aborted) return;
  yield {
    type: "done",
    answer,
    reasoning: reasoning || undefined,
    conversationId,
    messageId,
    resumeToken,
    imagePointers: pointers.size ? [...pointers.values()] : undefined,
  };
}
