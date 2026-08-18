import { Worker } from "node:worker_threads";
import { CancellationError, V2Error } from "./errors.ts";

export interface PowJobOptions {
  config: unknown[];
  seed: string;
  target: string;
  prefix: "gAAAAAC" | "gAAAAAB";
  maxIterations: number;
}

interface QueuedJob extends PowJobOptions {
  id: number;
  signal?: AbortSignal;
  deadlineMs?: number;
  cancelBuffer: SharedArrayBuffer;
  deadlineAt: number;
  resolve: (result: { token: string; solved: boolean; iterations: number }) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

interface WorkerSlot {
  worker: Worker;
  busy: QueuedJob | null;
  retired?: boolean;
}

/** Bounded worker-thread PoW executor. One account request still owns one coordinator slot. */
export class PowWorkerPool {
  private readonly size: number;
  private readonly queue: QueuedJob[] = [];
  private readonly slots: WorkerSlot[] = [];
  private nextId = 1;
  private closed = false;
  private started = false;

  constructor(size = 1) {
    this.size = Math.min(3, Math.max(1, Math.floor(size)));
  }

  async solve(options: PowJobOptions, signal?: AbortSignal, deadlineMs = 30_000): Promise<{ token: string; solved: boolean; iterations: number }> {
    if (this.closed) throw new V2Error("PoW worker pool is closed.", { category: "transport", status: 503, code: "POW_WORKER_CLOSED" });
    await this.start();
    return new Promise((resolve, reject) => {
      const cancelBuffer = new SharedArrayBuffer(4);
      const job: QueuedJob = { ...options, id: this.nextId++, signal, deadlineMs, deadlineAt: Date.now() + Math.max(1, deadlineMs || 30_000), cancelBuffer, resolve, reject };
      const abort = () => {
        if (job.timer) clearTimeout(job.timer);
        signal?.removeEventListener("abort", abort);
        Atomics.store(new Int32Array(cancelBuffer), 0, 1);
        const queuedIndex = this.queue.indexOf(job);
        if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
        reject(new CancellationError("PoW solve cancelled."));
      };
      job.abort = abort;
      if (signal?.aborted) return abort();
      job.timer = setTimeout(() => this.expire(job), Math.max(1, job.deadlineAt - Date.now()));
      (job.timer as any).unref?.();
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }

  private async start(): Promise<void> {
    if (this.started) return;
    try {
      for (let i = 0; i < this.size; i++) this.spawnWorker();
      this.started = true;
    } catch (error) {
      const slots = this.slots.splice(0);
      for (const slot of slots) slot.retired = true;
      await Promise.allSettled(slots.map((slot) => slot.worker.terminate()));
      throw new V2Error("PoW worker pool could not start.", { category: "transport", status: 503, code: "POW_WORKER_FAILED", cause: error });
    }
  }

  private spawnWorker(): WorkerSlot {
    const worker = new Worker(new URL("./pow-worker.ts", import.meta.url), { execArgv: ["--experimental-strip-types"] });
    const slot: WorkerSlot = { worker, busy: null };
    worker.on("message", (message) => this.complete(slot, message));
    worker.on("error", (error) => this.workerFailed(slot, error));
    worker.on("exit", (code) => { if (code !== 0 && !this.closed) this.workerFailed(slot, new Error(`PoW worker exited with code ${code}.`)); });
    this.slots.push(slot);
    return slot;
  }

  private drain(): void {
    for (const slot of this.slots) {
      if (slot.busy || !this.queue.length || this.closed) continue;
      const job = this.queue.shift()!;
      slot.busy = job;
      const cancelBuffer = new Int32Array(job.cancelBuffer);
      if (job.signal?.aborted) {
        Atomics.store(cancelBuffer, 0, 1);
        if (job.timer) clearTimeout(job.timer);
        job.signal.removeEventListener("abort", job.abort!);
        slot.busy = null;
        job.reject(new CancellationError("PoW solve cancelled."));
        continue;
      }
      slot.worker.postMessage({ id: job.id, config: job.config, seed: job.seed, target: job.target, prefix: job.prefix, maxIterations: job.maxIterations, cancelBuffer: job.cancelBuffer });
    }
  }

  private expire(job: QueuedJob): void {
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      job.signal?.removeEventListener("abort", job.abort!);
      job.reject(new V2Error("PoW solve deadline elapsed.", { category: "timeout", status: 504, code: "POW_TIMEOUT" }));
      return;
    }
    const slot = this.slots.find((candidate) => candidate.busy === job);
    if (!slot) return;
    Atomics.store(new Int32Array(job.cancelBuffer), 0, 1);
    job.signal?.removeEventListener("abort", job.abort!);
    job.reject(new V2Error("PoW solve deadline elapsed.", { category: "timeout", status: 504, code: "POW_TIMEOUT" }));
    slot.busy = null;
    slot.retired = true;
    void slot.worker.terminate().finally(() => {
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      if (!this.closed) {
        try { this.spawnWorker(); }
        catch (error) {
          this.started = false;
          for (const queued of this.queue.splice(0)) queued.reject(new V2Error("PoW worker pool could not recover.", { category: "transport", status: 503, code: "POW_WORKER_FAILED", cause: error }));
        }
      }
      this.drain();
    });
  }

  private complete(slot: WorkerSlot, message: any): void {
    const job = slot.busy;
    if (!job || message.id !== job.id) return;
    slot.busy = null;
    if (job.timer) clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort!);
    if (message.aborted) job.reject(new CancellationError("PoW solve cancelled."));
    else if (typeof message.token === "string") job.resolve({ token: message.token, solved: Boolean(message.solved), iterations: Number(message.iterations) });
    else job.reject(new V2Error("PoW worker returned an invalid result.", { category: "transport", status: 503, code: "POW_WORKER_INVALID_RESULT" }));
    this.drain();
  }

  private workerFailed(slot: WorkerSlot, error: unknown): void {
    if (slot.retired) return;
    slot.retired = true;
    const job = slot.busy;
    slot.busy = null;
    if (job) {
      if (job.timer) clearTimeout(job.timer);
      job.signal?.removeEventListener("abort", job.abort!);
      job.reject(new V2Error("PoW worker failed.", { category: "transport", status: 503, code: "POW_WORKER_FAILED", cause: error }));
    }
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    if (!this.closed) {
      try { this.spawnWorker(); } catch (spawnError) {
        this.started = false;
        for (const queued of this.queue.splice(0)) queued.reject(new V2Error("PoW worker pool could not recover.", { category: "transport", status: 503, code: "POW_WORKER_FAILED", cause: spawnError }));
      }
      this.drain();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      if (job.timer) clearTimeout(job.timer);
      job.signal?.removeEventListener("abort", job.abort!);
      job.reject(new CancellationError("PoW worker pool closed."));
    }
    for (const slot of this.slots) {
      if (slot.busy) {
        if (slot.busy.timer) clearTimeout(slot.busy.timer);
        slot.busy.signal?.removeEventListener("abort", slot.busy.abort!);
        slot.busy.reject(new CancellationError("PoW worker pool closed."));
      }
      slot.retired = true;
      slot.busy = null;
      await slot.worker.terminate();
    }
    this.slots.length = 0;
  }
}
