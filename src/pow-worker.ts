import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";

interface PowJob {
  id: number;
  config: unknown[];
  seed: string;
  target: string;
  prefix: string;
  maxIterations: number;
  cancelBuffer: SharedArrayBuffer;
}

if (!parentPort) throw new Error("PoW worker requires a parent port.");

parentPort.on("message", (job: PowJob) => {
  const cancelled = new Int32Array(job.cancelBuffer);
  const config = [...job.config];
  const maxIterations = Math.max(1, Math.floor(job.maxIterations));
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (Atomics.load(cancelled, 0) !== 0) {
      parentPort!.postMessage({ id: job.id, aborted: true });
      return;
    }
    config[3] = iteration;
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
    const digest = createHash("sha3-512").update(job.seed + encoded).digest("hex");
    if (job.target && digest.slice(0, job.target.length).toLowerCase() <= job.target.toLowerCase()) {
      parentPort!.postMessage({ id: job.id, token: `${job.prefix}${encoded}`, solved: true, iterations: iteration + 1 });
      return;
    }
  }
  config[3] = maxIterations - 1;
  parentPort!.postMessage({ id: job.id, token: `${job.prefix}${Buffer.from(JSON.stringify(config)).toString("base64")}`, solved: false, iterations: maxIterations });
});
