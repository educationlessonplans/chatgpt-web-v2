import { createHash } from "node:crypto";
import { CancellationError, SessionAuthError } from "./errors.ts";
import { cookieKey, mergeRotatedCookie, normalizeSessionCookie, safeErrorMessage } from "./redaction.ts";
import type { HttpTransport } from "./transport.ts";

export interface AuthSession {
  accessToken: string;
  accountId: string | null;
  expiresAt: number;
  cookie: string;
}

interface CachedSession extends AuthSession {
  cacheKey: string;
}

export interface SessionAuthOptions {
  baseUrl: string;
  transport: HttpTransport;
  cacheTtlMs?: number;
  onCookieRefreshed?: (cookie: string) => void | Promise<void>;
  log?: { debug?: (event: string, fields?: Record<string, unknown>) => void; warn?: (event: string, fields?: Record<string, unknown>) => void };
}

/** Cookie/session exchange with cache coalescing and atomic in-process cookie adoption. */
export class SessionAuthenticator {
  private readonly cache = new Map<string, CachedSession>();
  private readonly inflight = new Map<string, Promise<AuthSession>>();
  private adoptedCookie: string | null = null;
  private readonly cacheTtlMs: number;

  private readonly options: SessionAuthOptions;
  constructor(options: SessionAuthOptions) {
    this.options = options;
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
  }

  get currentCookie(): string | null {
    return this.adoptedCookie;
  }

  adoptCookie(cookie: string): void {
    this.adoptedCookie = normalizeSessionCookie(cookie);
  }

  invalidate(cookie?: string): void {
    if (!cookie) {
      this.cache.clear();
      return;
    }
    this.cache.delete(cookieKey(cookie));
  }

  async exchange(cookieInput: string | null | undefined, signal?: AbortSignal): Promise<AuthSession> {
    if (signal?.aborted) throw new CancellationError("Authentication exchange cancelled.");
    const supplied = normalizeSessionCookie(cookieInput || this.adoptedCookie || "");
    if (!supplied) throw new SessionAuthError("ChatGPT authentication is not configured.");
    const key = cookieKey(supplied);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now && cached.expiresAt - now > 1_000) {
      this.options.log?.debug?.("auth.cache_hit", { accountKey: key });
      return { ...cached };
    }
    const existing = this.inflight.get(key);
    if (existing) return awaitWithSignal(existing, signal);
    // The shared exchange is deliberately independent of one caller's AbortSignal.
    // Each waiter gets its own cancellation race, so one disconnected request cannot
    // cancel authentication for every concurrent session.
    const work = this.exchangeOnce(supplied, undefined).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return awaitWithSignal(work, signal);
  }

  private async exchangeOnce(cookie: string, signal?: AbortSignal): Promise<AuthSession> {
    let response;
    try {
      response = await this.options.transport.request({
        url: `${this.options.baseUrl}/api/auth/session`,
        method: "GET",
        headers: {
          Accept: "application/json",
          Cookie: cookie,
          Origin: this.options.baseUrl,
          Referer: `${this.options.baseUrl}/`,
        },
        signal,
        timeoutMs: 30_000,
      });
    } catch (error) {
      this.options.log?.warn?.("auth.exchange_failed", { message: safeErrorMessage(error) });
      throw error;
    }
    if (response.status === 401 || response.status === 403) {
      this.invalidate(cookie);
      throw new SessionAuthError("ChatGPT session cookie is invalid or expired.");
    }
    if (response.status >= 400) throw new SessionAuthError(`ChatGPT session exchange failed (HTTP ${response.status}).`);
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(response.text || "{}");
    } catch (error) {
      throw new SessionAuthError("ChatGPT session exchange returned malformed JSON.", error);
    }
    if (typeof payload.accessToken !== "string" || !payload.accessToken) {
      throw new SessionAuthError("ChatGPT session response did not contain an access token; cookie likely expired.");
    }
    const serverExpiry = payload.expires ? Date.parse(payload.expires) : Number.POSITIVE_INFINITY;
    const expiresAt = Math.min(
      Number.isFinite(serverExpiry) ? serverExpiry : Number.POSITIVE_INFINITY,
      Date.now() + this.cacheTtlMs,
    );
    const setCookies = typeof (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (response.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : response.headers.get("set-cookie");
    const refreshed = mergeRotatedCookie(cookie, setCookies);
    if (refreshed && refreshed !== cookie) {
      this.adoptedCookie = refreshed;
      await this.options.onCookieRefreshed?.(refreshed);
    } else {
      this.adoptedCookie = cookie;
    }
    const result: AuthSession = {
      accessToken: payload.accessToken,
      accountId: typeof payload.user?.id === "string" ? payload.user.id : null,
      expiresAt,
      cookie: refreshed || cookie,
    };
    const entry = { ...result, cacheKey: cookieKey(cookie) };
    this.cache.set(entry.cacheKey, entry);
    if (result.cookie !== cookie) this.cache.set(cookieKey(result.cookie), { ...entry, cacheKey: cookieKey(result.cookie) });
    while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
    this.options.log?.debug?.("auth.exchange_ok", { accountKey: entry.cacheKey, rotated: Boolean(refreshed) });
    return result;
  }
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new CancellationError("Authentication exchange cancelled.");
  let cleanup = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    const abort = () => reject(new CancellationError("Authentication exchange cancelled."));
    cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancellation]); }
  finally { cleanup(); }
}

export function deriveSessionId(cookie: string): string {
  const hash = createHash("sha256").update(normalizeSessionCookie(cookie)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${((3 & Number.parseInt(hash.slice(16, 17), 16)) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function buildCommonHeaders(baseUrl: string, userAgent: string): Record<string, string> {
  return {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Origin: baseUrl,
    Pragma: "no-cache",
    Referer: `${baseUrl}/`,
    "User-Agent": userAgent,
  };
}

export function buildOaiHeaders(options: {
  baseUrl: string;
  userAgent: string;
  clientVersion: string;
  clientBuildNumber: string;
  deviceId: string;
  sessionId: string;
  cookie: string;
  accessToken: string;
  accountId?: string | null;
  accept?: string;
}): Record<string, string> {
  return {
    ...buildCommonHeaders(options.baseUrl, options.userAgent),
    Accept: options.accept || "application/json",
    "OAI-Language": "en-US",
    "OAI-Device-Id": options.deviceId,
    "OAI-Client-Version": options.clientVersion,
    "OAI-Client-Build-Number": options.clientBuildNumber,
    "OAI-Session-Id": options.sessionId,
    Authorization: `Bearer ${options.accessToken}`,
    Cookie: normalizeSessionCookie(options.cookie),
    ...(options.accountId ? { "chatgpt-account-id": options.accountId } : {}),
    Priority: "u=1, i",
  };
}
