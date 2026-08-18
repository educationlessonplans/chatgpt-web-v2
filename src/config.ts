export const CONFIG_VERSION = 1 as const;

export interface V2Config {
  version: typeof CONFIG_VERSION;
  host: string;
  port: number;
  databasePath: string;
  imageCachePath: string;
  credentialFile: string;
  accountKey: string;
  sessionCookie: string | null;
  upstreamBaseUrl: string;
  transportMode: "tls" | "fetch";
  tlsRuntimeMode: "native" | "managed";
  tlsNativeLibraryPath: string | null;
  tlsProxyUrl: string | null;
  tlsIsRotatingProxy: boolean;
  tlsStartupTimeoutMs: number;
  tlsTempDir: string;
  tlsStreamFirstByteTimeoutMs: number;
  userAgent: string;
  clientVersion: string;
  clientBuildNumber: string;
  maxConcurrency: number;
  queueMax: number;
  queueTimeoutMs: number;
  requestTimeoutMs: number;
  handoffTimeoutMs: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  authCacheTtlMs: number;
  dplCacheTtlMs: number;
  reasoningEnabled: boolean;
  maxBodyBytes: number;
  powWorkerPoolSize: number;
  logLevel: "silent" | "error" | "warn" | "info" | "debug";
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0";

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function safeUrl(value: string | undefined, fallback: string): string {
  try {
    const url = new URL(value || fallback);
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

/** Load versioned, bounded configuration. Secrets are intentionally not included in diagnostics. */
export function loadConfig(env: Record<string, string | undefined> = process.env): V2Config {
  const maxConcurrency = Math.min(3, positiveInt(env.CHATGPT_WEB_V2_MAX_CONCURRENCY, 1, 3));
  const root = env.CHATGPT_WEB_V2_DATA_DIR || "./data";
  return {
    version: CONFIG_VERSION,
    host: env.CHATGPT_WEB_V2_HOST || "127.0.0.1",
    port: positiveInt(env.CHATGPT_WEB_V2_PORT, 20129, 65535),
    databasePath: env.CHATGPT_WEB_V2_DATABASE || `${root}/sessions.sqlite`,
    imageCachePath: env.CHATGPT_WEB_V2_IMAGE_CACHE || `${root}/images`,
    credentialFile: env.CHATGPT_WEB_V2_CREDENTIAL_FILE || `${root}/session-cookie`,
    accountKey: env.CHATGPT_WEB_V2_ACCOUNT_KEY || "default",
    sessionCookie: env.CHATGPT_SESSION_COOKIE || null,
    upstreamBaseUrl: safeUrl(env.CHATGPT_WEB_V2_UPSTREAM_BASE_URL, "https://chatgpt.com"),
    transportMode: env.CHATGPT_WEB_V2_TRANSPORT === "fetch" && bool(env.CHATGPT_WEB_V2_ALLOW_FETCH, false) ? "fetch" : "tls",
    tlsRuntimeMode: env.CHATGPT_WEB_V2_TLS_RUNTIME === "managed" ? "managed" : "native",
    tlsNativeLibraryPath: env.CHATGPT_WEB_V2_TLS_NATIVE_LIBRARY || null,
    tlsProxyUrl: env.CHATGPT_WEB_V2_TLS_PROXY_URL || null,
    tlsIsRotatingProxy: bool(env.CHATGPT_WEB_V2_TLS_ROTATING_PROXY, false),
    tlsStartupTimeoutMs: positiveInt(env.CHATGPT_WEB_V2_TLS_STARTUP_TIMEOUT_MS, 20_000, 120_000),
    tlsTempDir: env.CHATGPT_WEB_V2_TLS_TEMP_DIR || `${root}/tls-streams`,
    tlsStreamFirstByteTimeoutMs: positiveInt(env.CHATGPT_WEB_V2_TLS_FIRST_BYTE_TIMEOUT_MS, 30_000, 120_000),
    userAgent: env.CHATGPT_WEB_V2_USER_AGENT || DEFAULT_USER_AGENT,
    clientVersion:
      env.CHATGPT_WEB_V2_CLIENT_VERSION || "prod-81e0c5cdf6140e8c5db714d613337f4aeab94029",
    clientBuildNumber: env.CHATGPT_WEB_V2_CLIENT_BUILD_NUMBER || "6128297",
    maxConcurrency,
    queueMax: positiveInt(env.CHATGPT_WEB_V2_QUEUE_MAX, 8, 1000),
    queueTimeoutMs: positiveInt(env.CHATGPT_WEB_V2_QUEUE_TIMEOUT_MS, 30_000, 300_000),
    requestTimeoutMs: positiveInt(env.CHATGPT_WEB_V2_REQUEST_TIMEOUT_MS, 120_000, 3_600_000),
    handoffTimeoutMs: positiveInt(env.CHATGPT_WEB_V2_HANDOFF_TIMEOUT_MS, 1_200_000, 3_600_000),
    pollIntervalMs: positiveInt(env.CHATGPT_WEB_V2_POLL_INTERVAL_MS, 4_000, 60_000),
    pollTimeoutMs: positiveInt(env.CHATGPT_WEB_V2_POLL_TIMEOUT_MS, 1_200_000, 3_600_000),
    authCacheTtlMs: positiveInt(env.CHATGPT_WEB_V2_AUTH_CACHE_TTL_MS, 300_000, 3_600_000),
    dplCacheTtlMs: positiveInt(env.CHATGPT_WEB_V2_DPL_CACHE_TTL_MS, 3_600_000, 86_400_000),
    reasoningEnabled: bool(env.CHATGPT_WEB_V2_REASONING, false),
    maxBodyBytes: positiveInt(env.CHATGPT_WEB_V2_MAX_BODY_BYTES, 2_000_000, 20_000_000),
    powWorkerPoolSize: positiveInt(env.CHATGPT_WEB_V2_POW_WORKER_POOL_SIZE, 1, 3),
    logLevel: /^(silent|error|warn|info|debug)$/.test(env.CHATGPT_WEB_V2_LOG_LEVEL || "")
      ? (env.CHATGPT_WEB_V2_LOG_LEVEL as V2Config["logLevel"])
      : "info",
  };
}

export function publicConfig(config: V2Config): Omit<V2Config, "sessionCookie"> & { credentialConfigured: boolean } {
  const { sessionCookie: _, ...safe } = config;
  return { ...safe, credentialConfigured: Boolean(config.sessionCookie) };
}
