import { loadConfig, type V2Config } from "./config.ts";
import { FetchTransport, TlsClientTransport, type HttpTransport } from "./transport.ts";
import { SessionAuthenticator } from "./auth.ts";
import { DplDiscovery, SentinelClient } from "./sentinel.ts";
import { ConversationClient } from "./conversation.ts";
import { SessionStore } from "./sessions/store.ts";
import { AccountAdmission } from "./admission.ts";
import { createLogger } from "./logger.ts";
import { TurnCoordinator } from "./coordinator.ts";
import { PersistentImageCache } from "./images.ts";
import { createHttpServer } from "./api.ts";
import { CredentialStore } from "./credentials.ts";
import { asV2Error, type V2Error } from "./errors.ts";
import { PowWorkerPool } from "./pow.ts";

export function createService(config: V2Config = loadConfig()) {
  const logger = createLogger(config.logLevel);
  const credentialStore = new CredentialStore(config.credentialFile);
  let credentialError: V2Error | null = null;
  let sessionCookie = config.sessionCookie;
  try {
    sessionCookie = credentialStore.load(config.sessionCookie);
  } catch (error) {
    credentialError = asV2Error(error, "Operator credential store is unavailable.");
    logger.error("auth.credential_store_unavailable", { code: credentialError.code });
    sessionCookie = null;
  }
  const runtimeConfig = { ...config, sessionCookie };
  const fetchTransport = new FetchTransport({ userAgent: config.userAgent, logger: { warn: (event, data) => logger.warn(event, data as Record<string, unknown>) } });
  const tlsTransport = new TlsClientTransport({
    userAgent: runtimeConfig.userAgent,
    proxyUrl: runtimeConfig.tlsProxyUrl,
    isRotatingProxy: runtimeConfig.tlsIsRotatingProxy,
    startupTimeoutMs: runtimeConfig.tlsStartupTimeoutMs,
    nativeLibraryPath: runtimeConfig.tlsNativeLibraryPath,
    runtimeMode: runtimeConfig.tlsRuntimeMode,
    tempDir: runtimeConfig.tlsTempDir,
    streamFirstByteTimeoutMs: runtimeConfig.tlsStreamFirstByteTimeoutMs,
    logger: { warn: (event, data) => logger.warn(event, data as Record<string, unknown>), error: (event, data) => logger.error(event, data as Record<string, unknown>) },
  });
  const transport: HttpTransport = runtimeConfig.transportMode === "fetch" ? fetchTransport : tlsTransport;
  const transportReady = runtimeConfig.transportMode === "fetch" ? Promise.resolve() : tlsTransport.initialize();
  transportReady.catch(() => undefined);
  const sessions = new SessionStore(runtimeConfig.databasePath, runtimeConfig.accountKey);
  const powPool = new PowWorkerPool(runtimeConfig.powWorkerPoolSize);
  const auth = new SessionAuthenticator({ baseUrl: runtimeConfig.upstreamBaseUrl, transport, cacheTtlMs: runtimeConfig.authCacheTtlMs, log: logger, onCookieRefreshed: (cookie) => { credentialStore.write(cookie); logger.info("auth.cookie_rotated", { rotated: true }); } });
  const dpl = new DplDiscovery({ baseUrl: runtimeConfig.upstreamBaseUrl, fallbackClientVersion: runtimeConfig.clientVersion, transport, cacheTtlMs: runtimeConfig.dplCacheTtlMs });
  const sentinel = new SentinelClient(runtimeConfig, transport, dpl, powPool);
  const conversation = new ConversationClient({ config: runtimeConfig, transport, log: logger });
  const admission = new AccountAdmission(runtimeConfig.maxConcurrency, runtimeConfig.queueMax, runtimeConfig.queueTimeoutMs);
  const coordinator = new TurnCoordinator({ config: runtimeConfig, auth, sentinel, conversation, sessions, admission, log: logger });
  const images = new PersistentImageCache(runtimeConfig.imageCachePath, 1_800_000, 64 * 1024 * 1024);
  const server = createHttpServer({ config: runtimeConfig, coordinator, images, credentialError, transportReady: () => runtimeConfig.transportMode === "fetch" || tlsTransport.ready, transportError: () => tlsTransport.error });
  return { config: runtimeConfig, logger, transport, fetchTransport, tlsTransport, transportReady, credentialStore, credentialError, powPool, sessions, auth, dpl, sentinel, conversation, admission, coordinator, images, server };
}
