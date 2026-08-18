import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const baselinePath = new URL("../integrity/omniroute-v1-baseline.json", import.meta.url);
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const failures = [];
for (const artifact of baseline.artifacts || []) {
  try {
    const bytes = await readFile(artifact.path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== artifact.sha256) failures.push(`${artifact.path}: checksum mismatch`);
  } catch (error) {
    failures.push(`${artifact.path}: unavailable`);
  }
}
if (failures.length) {
  console.error("OmniRoute v1 integrity verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OmniRoute v1 integrity verified (${baseline.artifacts.length} artifacts).`);
}
