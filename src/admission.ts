import { QueueFullError, QueueTimeoutError, V2Error } from "./errors.ts";

export type HealthState = "healthy" | "cooling_down" | "authentication_invalid" | "sentinel_blocked" | "transport_unavailable";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  cleanup?: () => void;
}

const DEFAULT_COOLDOWNS: Record<string, number> = {
  rate_limit: 15_000,
  sentinel: 30_000,
  authentication: 0,
  transport: 5_000,
};

/** Bounded account-wide admission with deadline-aware waiters and health cooldowns. */
export class AccountAdmission {
  private active = 0;
  private queue: Waiter[] = [];
  private healthState: HealthState = "healthy";
  private cooldownUntil = 0;
  private lastFailure: string | null = null;

  readonly maxConcurrency: number;
  readonly queueMax: number;
  readonly queueTimeoutMs: number;
  private readonly now: () => number;
  constructor(maxConcurrency = 1, queueMax = 8, queueTimeoutMs = 30_000, now: () => number = Date.now) {
    this.maxConcurrency = maxConcurrency;
    this.queueMax = queueMax;
    this.queueTimeoutMs = queueTimeoutMs;
    this.now = now;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 3) throw new RangeError("maxConcurrency must be 1..3");
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.queue.length; }

  snapshot(): { state: HealthState; active: number; queued: number; cooldownUntil: number; lastFailure: string | null } {
    if (this.healthState === "cooling_down" && this.now() >= this.cooldownUntil) this.healthState = "healthy";
    return { state: this.healthState, active: this.active, queued: this.queue.length, cooldownUntil: this.cooldownUntil, lastFailure: this.lastFailure };
  }

  setHealth(state: HealthState, cooldownMs = 0, reason: string | null = null): void {
    this.healthState = state;
    this.cooldownUntil = state === "cooling_down" ? this.now() + Math.max(0, cooldownMs) : 0;
    this.lastFailure = reason;
    if (state === "cooling_down" && cooldownMs > 0) {
      const timer = setTimeout(() => this.drain(), cooldownMs);
      (timer as any).unref?.();
    }
    if (state === "authentication_invalid" || state === "sentinel_blocked") {
      const error = new V2Error(state === "authentication_invalid" ? "ChatGPT authentication is invalid." : "ChatGPT Sentinel is blocked.", {
        category: state === "authentication_invalid" ? "authentication" : "sentinel",
        status: state === "authentication_invalid" ? 401 : 403,
        code: state === "authentication_invalid" ? "AUTH_REQUIRED" : "SENTINEL_BLOCKED",
      });
      for (const waiter of this.queue.splice(0)) this.rejectWaiter(waiter, error);
    }
  }

  recordFailure(category: "rate_limit" | "sentinel" | "authentication" | "transport", reason?: string): void {
    if (category === "authentication") this.setHealth("authentication_invalid", 0, reason || category);
    else if (category === "sentinel") this.setHealth("sentinel_blocked", 0, reason || category);
    else this.setHealth("cooling_down", DEFAULT_COOLDOWNS[category], reason || category);
  }

  recordSuccess(): void {
    if (this.healthState === "cooling_down") this.healthState = "healthy";
    this.lastFailure = null;
    this.cooldownUntil = 0;
  }

  async acquire(signal?: AbortSignal, deadlineMs = this.queueTimeoutMs): Promise<() => void> {
    if (signal?.aborted) throw new QueueTimeoutError("ChatGPT queue wait cancelled.");
    const snapshot = this.snapshot();
    if (snapshot.state === "authentication_invalid") throw new V2Error("ChatGPT authentication is invalid.", { category: "authentication", status: 401, code: "AUTH_REQUIRED" });
    if (snapshot.state === "sentinel_blocked") throw new V2Error("ChatGPT Sentinel is blocked.", { category: "sentinel", status: 403, code: "SENTINEL_BLOCKED" });
    const cooling = snapshot.state === "cooling_down" && snapshot.cooldownUntil > this.now();
    if (cooling && this.queue.length >= this.queueMax) throw new QueueFullError();
    if (!cooling && this.active < this.maxConcurrency && this.queue.length === 0) {
      this.active++;
      return this.release;
    }
    if (this.queue.length >= this.queueMax) throw new QueueFullError();
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        settled: false,
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.queue = this.queue.filter((item) => item !== waiter);
          waiter.cleanup?.();
          reject(new QueueTimeoutError());
        }, Math.max(1, deadlineMs)),
      };
      const abort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        this.queue = this.queue.filter((item) => item !== waiter);
        waiter.cleanup?.();
        reject(new QueueTimeoutError("ChatGPT queue wait cancelled."));
      };
      waiter.cleanup = () => signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release = (): void => {
    if (this.active > 0) this.active--;
    this.drain();
  };

  private drain(): void {
    const snapshot = this.snapshot();
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      if (snapshot.state === "authentication_invalid" || snapshot.state === "sentinel_blocked") return;
      if (snapshot.state === "cooling_down" && snapshot.cooldownUntil > this.now()) return;
      const waiter = this.queue.shift()!;
      if (waiter.settled || waiter.signal?.aborted) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.cleanup?.();
      this.active++;
      waiter.resolve(this.release);
    }
  }

  private rejectWaiter(waiter: Waiter, error: Error): void {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.cleanup?.();
    waiter.reject(error);
  }
}

export class AsyncMutex {
  private locked = false;
  private waiters: Array<{ settled: boolean; resolve: () => void; reject: (error: Error) => void; abort?: () => void; cleanup?: () => void }> = [];
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new QueueTimeoutError("Session mutex wait cancelled.");
    if (!this.locked) {
      this.locked = true;
      return this.release;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { settled: false, resolve, reject } as { settled: boolean; resolve: () => void; reject: (error: Error) => void; abort?: () => void; cleanup?: () => void };
      const abort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new QueueTimeoutError("Session mutex wait cancelled."));
      };
      waiter.abort = abort;
      waiter.cleanup = () => signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
    this.locked = true;
    return this.release;
  }
  private release = (): void => {
    while (this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.cleanup?.();
      waiter.resolve();
      return;
    }
    this.locked = false;
  };
}
