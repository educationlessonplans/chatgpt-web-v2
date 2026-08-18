import { createHash, randomUUID } from "node:crypto";
import type { V2Config } from "./config.ts";
import { CancellationError, SentinelBlockedError } from "./errors.ts";
import { buildOaiHeaders } from "./auth.ts";
import type { AuthSession } from "./auth.ts";
import type { HttpTransport } from "./transport.ts";
import type { PowWorkerPool } from "./pow.ts";

export interface DplInfo {
  dpl: string;
  scriptSrc: string;
  expiresAt: number;
}

export interface SentinelRequirements {
  token?: string;
  prepare_token?: string;
  proof_token?: string;
  proofofwork?: { required?: boolean; seed?: string; difficulty?: string };
  turnstile?: { required?: boolean };
}

export interface BrowserFingerprintOptions {
  userAgent: string;
  dpl: string;
  scriptSrc: string;
  now?: Date;
  performanceNow?: number;
  random?: () => number;
  uuid?: string;
}

const FINGERPRINT_PROPERTIES = [
  "webdriver−false",
  "geolocation",
  "languages",
  "language",
  "platform",
  "userAgent",
  "vendor",
  "hardwareConcurrency",
  "deviceMemory",
  "permissions",
  "plugins",
  "mediaDevices",
];
const WINDOW_PROPERTIES = ["_reactListeningkfj3eavmks", "_reactListeningo743lnnpvdg", "location", "scrollingElement", "documentElement"];
const GLOBAL_PROPERTIES = ["webpackChunk_N_E", "__NEXT_DATA__", "chrome", "history", "screen", "navigation", "scrollX", "scrollY"];

function choose<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)] as T;
}

export function buildBrowserFingerprint(options: BrowserFingerprintOptions): unknown[] {
  const random = options.random || Math.random;
  const now = options.now || new Date();
  const performanceNow = options.performanceNow ?? 1;
  const epochOffset = now.getTime() - performanceNow;
  return [
    choose([3000, 4000, 3120, 4160], random),
    now.toString(),
    0xfffc0000,
    0,
    options.userAgent,
    options.scriptSrc,
    options.dpl,
    "en-US",
    "en-US,en",
    0,
    choose(FINGERPRINT_PROPERTIES, random),
    choose(WINDOW_PROPERTIES, random),
    choose(GLOBAL_PROPERTIES, random),
    performanceNow,
    options.uuid || randomUUID(),
    "",
    choose([8, 16, 24, 32], random),
    epochOffset,
  ];
}

export interface PowOptions {
  config: unknown[];
  seed: string;
  target: string;
  prefix: "gAAAAAC" | "gAAAAAB";
  maxIterations: number;
  yieldEvery?: number;
  onProgress?: (iteration: number) => void;
}

/** Pure deterministic PoW implementation matching the audited browser client shape. */
export async function solvePow(options: PowOptions): Promise<{ token: string; solved: boolean; iterations: number }> {
  const config = [...options.config];
  const maxIterations = Math.max(1, Math.floor(options.maxIterations));
  const yieldEvery = Math.max(1, options.yieldEvery || 1000);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (iteration > 0 && iteration % yieldEvery === 0) {
      options.onProgress?.(iteration);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    config[3] = iteration;
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
    const digest = createHash("sha3-512").update(options.seed + encoded).digest("hex");
    if (options.target && digest.slice(0, options.target.length).toLowerCase() <= options.target.toLowerCase()) {
      return { token: `${options.prefix}${encoded}`, solved: true, iterations: iteration + 1 };
    }
  }
  config[3] = maxIterations - 1;
  return {
    token: `${options.prefix}${Buffer.from(JSON.stringify(config)).toString("base64")}`,
    solved: false,
    iterations: maxIterations,
  };
}

export async function solvePreparePow(config: unknown[], onProgress?: (iteration: number) => void): Promise<string> {
  return (await solvePow({ config, seed: "", target: "0fffff", prefix: "gAAAAAC", maxIterations: 100_000, onProgress })).token;
}

export async function solveConversationPow(seed: string, difficulty: string, config: unknown[], onProgress?: (iteration: number) => void): Promise<string> {
  return (await solvePow({ config, seed, target: difficulty, prefix: "gAAAAAB", maxIterations: 500_000, onProgress })).token;
}

export class DplDiscovery {
  private cached: DplInfo | null = null;
  private readonly options: { baseUrl: string; fallbackClientVersion: string; transport: HttpTransport; cacheTtlMs?: number };
  constructor(options: { baseUrl: string; fallbackClientVersion: string; transport: HttpTransport; cacheTtlMs?: number }) { this.options = options; }

  invalidate(): void { this.cached = null; }

  async discover(cookie: string, signal?: AbortSignal): Promise<DplInfo> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached;
    const fallback = `dpl=${this.options.fallbackClientVersion.replace(/^prod-/, "")}`;
    try {
      const response = await this.options.transport.request({
        url: `${this.options.baseUrl}/`,
        method: "GET",
        headers: { Accept: "text/html,application/xhtml+xml", Cookie: cookie },
        timeoutMs: 20_000,
        signal,
      });
      const html = response.text || "";
      const build = html.match(/data-build="([^"]+)"/i)?.[1];
      const script = html.match(/<script[^>]+src="(https?:\/\/[^"']+\.js[^"']*)"/i)?.[1];
      this.cached = {
        dpl: build ? `dpl=${build}` : fallback,
        scriptSrc: script || `${this.options.baseUrl}/_next/static/chunks/webpack-${randomUUID().replaceAll("-", "").slice(0, 16)}.js`,
        expiresAt: Date.now() + (this.options.cacheTtlMs ?? 3_600_000),
      };
      return this.cached;
    } catch (error) {
      if (signal?.aborted || error instanceof CancellationError) throw new CancellationError("DPL discovery cancelled.", error);
      return { dpl: fallback, scriptSrc: `${this.options.baseUrl}/_next/static/chunks/webpack-fallback.js`, expiresAt: Date.now() + 60_000 };
    }
  }
}

function json(text: string): Record<string, any> {
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

export class SentinelClient {
  private readonly config: Pick<V2Config, "upstreamBaseUrl" | "userAgent" | "clientVersion" | "clientBuildNumber">;
  private readonly transport: HttpTransport;
  private readonly dpl: DplDiscovery;
  private readonly powPool: PowWorkerPool | null;
  constructor(config: Pick<V2Config, "upstreamBaseUrl" | "userAgent" | "clientVersion" | "clientBuildNumber">, transport: HttpTransport, dpl: DplDiscovery, powPool: PowWorkerPool | null = null) { this.config = config; this.transport = transport; this.dpl = dpl; this.powPool = powPool; }

  async prepare(session: AuthSession, signal?: AbortSignal): Promise<SentinelRequirements> {
    const dplInfo = await this.dpl.discover(session.cookie, signal);
    const fingerprint = buildBrowserFingerprint({ userAgent: this.config.userAgent, dpl: dplInfo.dpl, scriptSrc: dplInfo.scriptSrc });
    const preparePow = this.powPool
      ? (await this.powPool.solve({ config: fingerprint, seed: "", target: "0fffff", prefix: "gAAAAAC", maxIterations: 100_000 }, signal, 30_000)).token
      : await solvePreparePow(fingerprint);
    const common = buildOaiHeaders({
      baseUrl: this.config.upstreamBaseUrl,
      userAgent: this.config.userAgent,
      clientVersion: this.config.clientVersion,
      clientBuildNumber: this.config.clientBuildNumber,
      deviceId: randomUUID(),
      sessionId: randomUUID(),
      cookie: session.cookie,
      accessToken: session.accessToken,
      accountId: session.accountId,
      accept: "*/*",
    });
    const prepareResponse = await this.transport.request({
      url: `${this.config.upstreamBaseUrl}/backend-api/sentinel/chat-requirements/prepare`,
      method: "POST",
      headers: { ...common, "Content-Type": "application/json" },
      body: JSON.stringify({ p: preparePow }),
      signal,
      timeoutMs: 30_000,
    });
    if (prepareResponse.status === 401 || prepareResponse.status === 403) throw new SentinelBlockedError(`Sentinel prepare rejected (HTTP ${prepareResponse.status}).`);
    if (prepareResponse.status >= 400) throw new Error(`Sentinel prepare failed (HTTP ${prepareResponse.status}).`);
    const first = json(prepareResponse.text);
    if (!first.prepare_token) return first;
    const requirementsResponse = await this.transport.request({
      url: `${this.config.upstreamBaseUrl}/backend-api/sentinel/chat-requirements`,
      method: "POST",
      headers: { ...common, "Content-Type": "application/json" },
      body: JSON.stringify({ p: preparePow, prepare_token: first.prepare_token }),
      signal,
      timeoutMs: 30_000,
    });
    if (requirementsResponse.status === 401 || requirementsResponse.status === 403) throw new SentinelBlockedError(`Sentinel requirements rejected (HTTP ${requirementsResponse.status}).`);
    if (requirementsResponse.status >= 400) return { ...first, prepare_token: first.prepare_token };
    const requirements = { ...json(requirementsResponse.text), prepare_token: first.prepare_token } as SentinelRequirements;
    if (requirements.proofofwork?.required && requirements.proofofwork.seed && requirements.proofofwork.difficulty) {
      requirements.proof_token = this.powPool
        ? (await this.powPool.solve({ config: fingerprint, seed: requirements.proofofwork.seed, target: requirements.proofofwork.difficulty, prefix: "gAAAAAB", maxIterations: 500_000 }, signal, 120_000)).token
        : await solveConversationPow(requirements.proofofwork.seed, requirements.proofofwork.difficulty, fingerprint);
    }
    return requirements;
  }
}
