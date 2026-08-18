import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const node = process.execPath;
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "data"].includes(entry.name)) await walk(path);
    else if (entry.isFile() && /\.(m?js|ts)$/.test(entry.name)) files.push(path);
  }
}
await walk(root);
for (const file of files.sort()) {
  const result = spawnSync(node, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} source/test/script files.`);
