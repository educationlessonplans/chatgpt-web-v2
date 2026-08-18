import { asV2Error, CancellationError } from "./errors.ts";
import { TlsUnavailableError } from "./errors.ts";
import { safeErrorMessage, safeHeaders } from "./redaction.ts";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export interface TransportRequest {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  stream?: boolean;
  proxyUrl?: string | null;
  isRotatingProxy?: boolean;
}

export interface TransportResponse {
  status: number;
  headers: Headers;
  text: string;
  body: ReadableStream<Uint8Array> | null;
}

export interface HttpTransport {
  request(request: TransportRequest): Promise<TransportResponse>;
}

export interface TlsTransportOptions {
  userAgent?: string;
  proxyUrl?: string | null;
  isRotatingProxy?: boolean;
  clientIdentifier?: string;
  withRandomTLSExtensionOrder?: boolean;
  followRedirects?: boolean;
  startupTimeoutMs?: number;
  nativeLibraryPath?: string | null;
  runtimeMode?: "native" | "managed";
  tempDir?: string;
  streamFirstByteTimeoutMs?: number;
  logger?: { warn?: (event: string, data?: unknown) => void; error?: (event: string, data?: unknown) => void };
}

function mergeSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal?: AbortSignal; dispose: () => void } {
  if (!timeoutMs || timeoutMs <= 0) return { signal, dispose: () => {} };
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return { signal: timeout, dispose: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || timeout.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", () => controller.abort(timeout.reason), { once: true });
  return { signal: controller.signal, dispose: () => signal.removeEventListener("abort", abort) };
}

export class FetchTransport implements HttpTransport {
  private readonly defaults: { userAgent?: string; logger?: { warn?: (event: string, data?: unknown) => void } };
  constructor(defaults: { userAgent?: string; logger?: { warn?: (event: string, data?: unknown) => void } } = {}) { this.defaults = defaults; }

  async request(request: TransportRequest): Promise<TransportResponse> {
    const merged = mergeSignals(request.signal, request.timeoutMs);
    const headers = new Headers(request.headers);
    if (this.defaults.userAgent && !headers.has("user-agent")) headers.set("user-agent", this.defaults.userAgent);
    try {
      const response = await fetch(request.url, {
        method: request.method || "GET",
        headers,
        body: request.body as any,
        signal: merged.signal,
      });
      if (request.stream && response.body) {
        return { status: response.status, headers: response.headers, text: "", body: response.body };
      }
      return { status: response.status, headers: response.headers, text: await response.text(), body: null };
    } catch (error) {
      this.defaults.logger?.warn?.("transport.error", { message: safeErrorMessage(error), headers: safeHeaders(headers) });
      throw asV2Error(error, "ChatGPT transport request failed.");
    } finally {
      merged.dispose();
    }
  }
}

type TlsClientLike = {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(url: string, options?: Record<string, unknown>): Promise<{
    status: number;
    body: string;
    headers: Record<string, string[]>;
    text?: () => Promise<string>;
    bytes?: () => Promise<Uint8Array>;
  }>;
};

type TlsResponseLike = Awaited<ReturnType<TlsClientLike["request"]>>;

const DEFAULT_STREAM_FIRST_BYTE_TIMEOUT_MS = 30_000;
const STREAM_POLL_INTERVAL_MS = 25;
const STREAM_READ_SIZE = 64 * 1024;

function packageNativeLibraryPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("tls-client-node/package.json");
    const bin = join(dirname(packageJson), "bin");
    const prefix = process.platform === "linux" && process.arch === "x64"
      ? "tls-client-linux-ubuntu-amd64-"
      : process.platform === "linux" && process.arch === "arm64"
        ? "tls-client-linux-arm64-"
        : process.platform === "darwin" && process.arch === "x64"
          ? "tls-client-darwin-amd64-"
          : process.platform === "darwin" && process.arch === "arm64"
            ? "tls-client-darwin-arm64-"
            : process.platform === "win32" && process.arch === "x64"
              ? "tls-client-windows-64-"
              : null;
    if (!prefix || !existsSync(bin)) return null;
    const candidates = readdirSyncSafe(bin).filter((entry) => entry.startsWith(prefix));
    return candidates.length ? join(bin, candidates.sort().at(-1)!) : null;
  } catch {
    return null;
  }
}

function readdirSyncSafe(path: string): string[] {
  // Keeping this tiny sync lookup avoids an asynchronous race before native startup.
  try {
    const { readdirSync } = requireNodeFs();
    return readdirSync(path);
  } catch {
    return [];
  }
}

function requireNodeFs(): typeof import("node:fs") {
  const require = createRequire(import.meta.url);
  return require("node:fs");
}

function tlsHeaders(headers: Record<string, string[]>): Headers {
  const output = new Headers();
  for (const [name, values] of Object.entries(headers || {})) for (const value of values || []) output.append(name, String(value));
  return output;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function abortPromise(signal: AbortSignal | undefined): { promise: Promise<never> | null; dispose: () => void } {
  if (!signal) return { promise: null, dispose: () => {} };
  let rejectAbort: (error: unknown) => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason || new DOMException("Request cancelled", "AbortError"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return { promise, dispose: () => signal.removeEventListener("abort", abort) };
}

function looksLikeSse(text: string): boolean {
  const trimmed = text.replace(/^[\s\r\n]+/, "");
  if (!trimmed) return false;
  if (trimmed.startsWith(":")) return true;
  return /^(data|event|id|retry):/i.test(trimmed);
}

async function readFirstBytes(path: string, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new CancellationError("ChatGPT TLS stream cancelled.", signal.reason);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, Math.max(1, milliseconds));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new CancellationError("ChatGPT TLS stream cancelled.", signal?.reason));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    (timer as any).unref?.();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitForStreamContent(path: string, timeoutMs: number, operation: Promise<TlsResponseLike>, signal?: AbortSignal): Promise<boolean> {
  let operationSettled = false;
  operation.then(() => { operationSettled = true; }, () => { operationSettled = true; });
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new CancellationError("ChatGPT TLS stream cancelled.", signal.reason);
    try {
      if ((await stat(path)).size > 0) return true;
    } catch {
      // Native tls-client-node creates the path before its first body write.
    }
    if (operationSettled) return false;
    await sleepWithSignal(Math.min(STREAM_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), signal);
  }
  return false;
}

async function removeStreamDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

async function fallbackStreamResponse(response: TlsResponseLike, path: string, request: TransportRequest): Promise<TransportResponse> {
  const responseBody = typeof response.body === "string" ? response.body : await response.text?.() || "";
  let fileBody = "";
  try { fileBody = await readFile(path, "utf8"); } catch { /* stream file may not have been created */ }
  const text = fileBody || responseBody;
  const body = request.stream && text ? streamFromBytes(new TextEncoder().encode(text)) : null;
  return {
    status: response.status,
    headers: tlsHeaders(response.headers || {}),
    text: body ? "" : text,
    body,
  };
}

function tailStreamFile(
  path: string,
  eofSymbol: string,
  operation: Promise<TlsResponseLike>,
  signal: AbortSignal | undefined,
  cleanup: () => Promise<void>,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  let consumerCancelled = false;
  let signalCancelled = false;
  let demandResolve: (() => void) | null = null;
  const marker = Buffer.from(eofSymbol);
  const notifyDemand = () => {
    const resolve = demandResolve;
    demandResolve = null;
    resolve?.();
  };
  const waitForDemand = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    if (cancelled || controller.desiredSize === null || controller.desiredSize > 0) return;
    await new Promise<void>((resolve) => { demandResolve = resolve; });
  };
  const onAbort = () => {
    signalCancelled = true;
    cancelled = true;
    notifyDemand();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let handle: Awaited<ReturnType<typeof open>> | null = null;
        let errored = false;
        let operationError: Error | null = null;
        let operationSettled = false;
        operation.then(() => { operationSettled = true; notifyDemand(); }, (error) => {
          operationError = error instanceof Error ? error : new Error(String(error));
          operationSettled = true;
          notifyDemand();
        });
        try {
          handle = await open(path, "r");
          const buffer = Buffer.alloc(STREAM_READ_SIZE);
          let offset = 0;
          let pending = Buffer.alloc(0);
          let sawEof = false;
          while (!cancelled && !sawEof) {
            await waitForDemand(controller);
            if (cancelled) break;
            const result = await handle.read(buffer, 0, buffer.length, offset);
            if (result.bytesRead > 0) {
              offset += result.bytesRead;
              const combined = Buffer.concat([pending, buffer.subarray(0, result.bytesRead)]);
              const markerAt = combined.indexOf(marker);
              if (markerAt >= 0) {
                const output = combined.subarray(0, markerAt + marker.length);
                if (output.length && !cancelled) controller.enqueue(new Uint8Array(output));
                pending = Buffer.alloc(0);
                sawEof = true;
              } else {
                const retain = Math.max(0, marker.length - 1);
                const emitLength = Math.max(0, combined.length - retain);
                if (emitLength && !cancelled) {
                  await waitForDemand(controller);
                  if (!cancelled) controller.enqueue(new Uint8Array(combined.subarray(0, emitLength)));
                }
                pending = combined.subarray(emitLength);
              }
            } else if (operationSettled) {
              break;
            } else {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, STREAM_POLL_INTERVAL_MS);
                (timer as any).unref?.();
              });
            }
          }
          if (sawEof && !operationSettled) await operation.catch(() => undefined);
          if (!cancelled && pending.length) {
            await waitForDemand(controller);
            if (!cancelled) controller.enqueue(new Uint8Array(pending));
          }
          if (!cancelled && operationError) {
            controller.error(operationError);
            errored = true;
          }
        } catch (error) {
          if (!cancelled) {
            controller.error(error);
            errored = true;
          }
        } finally {
          if (handle) await handle.close().catch(() => undefined);
          await operation.catch(() => undefined);
          await cleanup();
          signal?.removeEventListener("abort", onAbort);
          if (signalCancelled && !consumerCancelled) {
            try { controller.error(new CancellationError("ChatGPT TLS stream cancelled.", signal?.reason)); } catch { /* consumer already closed */ }
          } else if (!cancelled && !errored) {
            try { controller.close(); } catch { /* consumer may have cancelled concurrently */ }
          }
        }
      })();
    },
    pull() { notifyDemand(); },
    cancel() { consumerCancelled = true; cancelled = true; notifyDemand(); },
  });
  return stream;
}

async function streamNativeResponse(
  operation: Promise<TlsResponseLike>,
  path: string,
  directory: string,
  request: TransportRequest,
  firstByteTimeoutMs: number,
): Promise<TransportResponse> {
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await operation.catch(() => undefined);
    await removeStreamDirectory(directory);
  };
  try {
    const ready = await waitForStreamContent(path, firstByteTimeoutMs, operation, request.signal);
    if (!ready) {
      const response = await operation;
      const fallback = await fallbackStreamResponse(response, path, request);
      await cleanup();
      return fallback;
    }
    const peek = await readFirstBytes(path, 256);
    if (!looksLikeSse(peek)) {
      const response = await operation;
      const fallback = await fallbackStreamResponse(response, path, request);
      await cleanup();
      return fallback;
    }
    if (request.signal?.aborted) throw new CancellationError("ChatGPT TLS stream cancelled.", request.signal.reason);
    // The native binding exposes status/headers only when its Promise settles.
    // For a positively identified SSE body we report 200 and stream immediately;
    // non-SSE/error bodies remain buffered until the real status is available.
    return {
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" }),
      text: "",
      body: tailStreamFile(path, "[DONE]", operation, request.signal, cleanup),
    };
  } catch (error) {
    void cleanup();
    throw asV2Error(error, "ChatGPT TLS transport request failed.");
  }
}

/**
 * Production transport. It deliberately uses tls-client-node's native binding and
 * never falls back to stock fetch when native startup fails.
 */
export class TlsClientTransport implements HttpTransport {
  private readonly options: Required<Pick<TlsTransportOptions, "clientIdentifier" | "withRandomTLSExtensionOrder" | "followRedirects" | "runtimeMode" | "startupTimeoutMs" | "tempDir" | "streamFirstByteTimeoutMs">> & TlsTransportOptions;
  private client: TlsClientLike | null = null;
  private startupPromise: Promise<void> | null = null;
  private startupError: TlsUnavailableError | null = null;
  private state: "uninitialized" | "ready" | "failed" = "uninitialized";

  constructor(options: TlsTransportOptions = {}) {
    this.options = {
      ...options,
      clientIdentifier: options.clientIdentifier || "firefox_148",
      withRandomTLSExtensionOrder: options.withRandomTLSExtensionOrder ?? true,
      followRedirects: options.followRedirects ?? true,
      runtimeMode: options.runtimeMode || "native",
      startupTimeoutMs: options.startupTimeoutMs || 20_000,
      tempDir: options.tempDir || join(tmpdir(), "chatgpt-web-v2-tls"),
      streamFirstByteTimeoutMs: options.streamFirstByteTimeoutMs || DEFAULT_STREAM_FIRST_BYTE_TIMEOUT_MS,
    };
  }

  get ready(): boolean { return this.state === "ready"; }
  get error(): TlsUnavailableError | null { return this.startupError; }

  async initialize(): Promise<void> {
    if (this.state === "ready") return;
    if (this.startupError) throw this.startupError;
    if (!this.startupPromise) {
      this.startupPromise = this.startInternal().catch((error) => {
        const unavailable = error instanceof TlsUnavailableError ? error : new TlsUnavailableError("Native TLS transport failed to initialize.", error);
        this.startupError = unavailable;
        this.state = "failed";
        this.options.logger?.error?.("transport.tls_unavailable", { code: unavailable.code, message: safeErrorMessage(error) });
        throw unavailable;
      }).finally(() => { this.startupPromise = null; });
    }
    return this.startupPromise;
  }

  private async startInternal(): Promise<void> {
    const nativePath = this.options.nativeLibraryPath || packageNativeLibraryPath();
    if (this.options.runtimeMode === "native" && (!nativePath || !existsSync(nativePath))) {
      throw new TlsUnavailableError("Native TLS library is not installed for this runtime.");
    }
    let client: TlsClientLike | null = null;
    try {
      const module = await import("tls-client-node");
      client = new module.TLSClient({
        runtimeMode: this.options.runtimeMode,
        ...(nativePath ? { nativeLibraryPath: nativePath } : {}),
        startupTimeoutMs: this.options.startupTimeoutMs,
      }) as TlsClientLike;
      await client.start();
      this.client = client;
      this.state = "ready";
    } catch (error) {
      if (client) await client.stop().catch(() => undefined);
      throw new TlsUnavailableError("Native TLS transport failed to initialize.", error);
    }
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    if (request.signal?.aborted) throw new CancellationError("ChatGPT TLS transport request cancelled.", request.signal.reason);
    await this.initialize();
    if (!this.client) throw new TlsUnavailableError();
    const tempRoot = this.options.tempDir;
    let requestTemp: string | null = null;
    let streamPath: string | undefined;
    if (request.stream) {
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      requestTemp = await mkdtemp(join(tempRoot, "request-"));
      streamPath = join(requestTemp, "response.sse");
    }
    const headers = Object.fromEntries(new Headers(request.headers).entries());
    if (this.options.userAgent && !headers["user-agent"]) headers["user-agent"] = this.options.userAgent;
    const options: Record<string, unknown> = {
      method: request.method || "GET",
      headers,
      body: request.body,
      tlsClientIdentifier: this.options.clientIdentifier,
      withRandomTLSExtensionOrder: this.options.withRandomTLSExtensionOrder,
      followRedirects: this.options.followRedirects,
      withoutCookieJar: true,
      timeoutMilliseconds: request.timeoutMs || 120_000,
      proxyUrl: request.proxyUrl ?? this.options.proxyUrl ?? undefined,
      isRotatingProxy: request.isRotatingProxy ?? this.options.isRotatingProxy ?? false,
      ...(streamPath ? { streamOutputPath: streamPath, streamOutputBlockSize: 1024, streamOutputEOFSymbol: "[DONE]" } : {}),
    };
    let operation: Promise<TlsResponseLike>;
    try {
      operation = Promise.resolve(this.client.request(request.url, options));
    } catch (error) {
      if (requestTemp) await rm(requestTemp, { recursive: true, force: true }).catch(() => undefined);
      throw asV2Error(error, "ChatGPT TLS transport request failed.");
    }
    let operationSettled = false;
    const operationDone = operation.then((value) => { operationSettled = true; return value; }, (error) => { operationSettled = true; throw error; });
    operationDone.catch(() => undefined);
    if (request.stream && requestTemp && streamPath) {
      return streamNativeResponse(operationDone, streamPath, requestTemp, request, this.options.streamFirstByteTimeoutMs);
    }
    const abort = abortPromise(request.signal);
    try {
      const tlsResponse = await (abort.promise ? Promise.race([operationDone, abort.promise]) : operationDone);
      const bodyText = typeof tlsResponse.body === "string" ? tlsResponse.body : await tlsResponse.text?.() || "";
      const responseHeaders = tlsHeaders(tlsResponse.headers || {});
      return {
        status: tlsResponse.status,
        headers: responseHeaders,
        text: bodyText,
        body: null,
      };
    } catch (error) {
      throw asV2Error(error, "ChatGPT TLS transport request failed.");
    } finally {
      abort.dispose();
      if (requestTemp) {
        const cleanup = () => rm(requestTemp!, { recursive: true, force: true }).catch(() => undefined);
        if (operationSettled) await cleanup();
        else void operationDone.finally(cleanup).catch(() => undefined);
      }
    }
  }

  async close(): Promise<void> {
    const pending = this.startupPromise;
    if (pending) await pending.catch(() => undefined);
    if (this.client) await this.client.stop().catch(() => undefined);
    this.client = null;
    this.state = "uninitialized";
  }
}

export class MockTransport implements HttpTransport {
  readonly requests: TransportRequest[] = [];
  private readonly handler: (request: TransportRequest, index: number) => Promise<TransportResponse> | TransportResponse;
  constructor(handler: (request: TransportRequest, index: number) => Promise<TransportResponse> | TransportResponse) { this.handler = handler; }
  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return this.handler(request, this.requests.length - 1);
  }
}

export function response(status: number, body: string | object, headers: HeadersInit = {}): TransportResponse {
  return { status, headers: new Headers(headers), text: typeof body === "string" ? body : JSON.stringify(body), body: null };
}

export function streamResponse(status: number, body: string, headers: HeadersInit = {}): TransportResponse {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return { status, headers: new Headers({ "content-type": "text/event-stream", ...Object.fromEntries(new Headers(headers)), }), text: "", body: stream };
}
