export type ErrorCategory =
  | "invalid_request"
  | "authentication"
  | "sentinel"
  | "rate_limit"
  | "transport"
  | "timeout"
  | "cancellation"
  | "uncertain_turn"
  | "upstream"
  | "queue";

export class V2Error extends Error {
  readonly category: ErrorCategory;
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly postAttempted: boolean;

  constructor(
    message: string,
    options: {
      category: ErrorCategory;
      status?: number;
      code?: string;
      retryable?: boolean;
      postAttempted?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "V2Error";
    this.category = options.category;
    this.status = options.status ?? 502;
    this.code = options.code ?? options.category.toUpperCase();
    this.retryable = options.retryable ?? false;
    this.postAttempted = options.postAttempted ?? false;
  }
}

export class SessionAuthError extends V2Error {
  constructor(message = "ChatGPT authentication failed; provide a valid session cookie.", cause?: unknown) {
    super(message, { category: "authentication", status: 401, code: "AUTH_REQUIRED", cause });
    this.name = "SessionAuthError";
  }
}

export class SentinelBlockedError extends V2Error {
  constructor(message = "ChatGPT blocked the Sentinel request; try again later.", cause?: unknown) {
    super(message, { category: "sentinel", status: 403, code: "SENTINEL_BLOCKED", cause });
    this.name = "SentinelBlockedError";
  }
}

export class QueueFullError extends V2Error {
  constructor(message = "ChatGPT account queue is full.") {
    super(message, { category: "queue", status: 429, code: "ACCOUNT_QUEUE_FULL", retryable: true });
    this.name = "QueueFullError";
  }
}

export class QueueTimeoutError extends V2Error {
  constructor(message = "ChatGPT account queue deadline elapsed.") {
    super(message, { category: "queue", status: 429, code: "ACCOUNT_QUEUE_TIMEOUT", retryable: true });
    this.name = "QueueTimeoutError";
  }
}

export class UncertainTurnError extends V2Error {
  constructor(message = "The ChatGPT turn outcome is uncertain; reconcile before sending another turn.", cause?: unknown) {
    super(message, {
      category: "uncertain_turn",
      status: 409,
      code: "UNCERTAIN_TURN",
      postAttempted: true,
      cause,
    });
    this.name = "UncertainTurnError";
  }
}

export class CancellationError extends V2Error {
  constructor(message = "Request cancelled.", cause?: unknown, postAttempted = false) {
    super(message, { category: "cancellation", status: 499, code: "REQUEST_CANCELLED", cause, postAttempted });
    this.name = "CancellationError";
  }
}

export class TlsUnavailableError extends V2Error {
  constructor(message = "The native TLS transport is unavailable.", cause?: unknown) {
    super(message, { category: "transport", status: 502, code: "TLS_UNAVAILABLE", cause });
    this.name = "TlsUnavailableError";
  }
}

export class CredentialStoreError extends V2Error {
  constructor(message = "The operator credential store is unavailable.", cause?: unknown) {
    super(message, { category: "authentication", status: 503, code: "CREDENTIAL_STORE_UNAVAILABLE", cause });
    this.name = "CredentialStoreError";
  }
}

export function mapHttpError(status: number, detail?: string): V2Error {
  if (status === 401 || status === 403) {
    return new SessionAuthError(detail || "ChatGPT authentication failed; re-paste the session cookie.");
  }
  if (status === 408 || status === 504) {
    return new V2Error(detail || "ChatGPT request timed out.", {
      category: "timeout",
      status: 504,
      code: "UPSTREAM_TIMEOUT",
      retryable: true,
    });
  }
  if (status === 429) {
    return new V2Error(detail || "ChatGPT rate limited the account.", {
      category: "rate_limit",
      status: 429,
      code: "UPSTREAM_RATE_LIMIT",
      retryable: true,
    });
  }
  if (status === 413) {
    return new V2Error(detail || "ChatGPT web payload is too large.", {
      category: "invalid_request",
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  }
  return new V2Error(detail || `ChatGPT returned HTTP ${status}.`, {
    category: "upstream",
    status: status >= 400 && status < 600 ? status : 502,
    code: `HTTP_${status}`,
    retryable: status >= 500,
  });
}

export function asV2Error(error: unknown, fallback = "ChatGPT request failed."): V2Error {
  if (error instanceof V2Error) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new CancellationError(fallback, error);
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return new V2Error(fallback, { category: "timeout", status: 504, code: "UPSTREAM_TIMEOUT", retryable: true, cause: error });
  }
  return new V2Error(fallback, { category: "transport", status: 502, code: "TRANSPORT_ERROR", retryable: true, cause: error });
}

export function publicError(error: unknown): { status: number; body: { error: { message: string; type: string; code: string } } } {
  const e = asV2Error(error);
  return {
    status: e.status,
    body: { error: { message: e.message, type: e.category, code: e.code } },
  };
}
