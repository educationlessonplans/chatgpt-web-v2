import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CredentialStoreError } from "./errors.ts";
import { normalizeSessionCookie } from "./redaction.ts";

/** Atomic operator-controlled cookie file. The path and contents are never included in diagnostics. */
export class CredentialStore {
  readonly filePath: string;
  constructor(filePath: string) { this.filePath = filePath; }

  load(environmentCookie?: string | null): string | null {
    try {
      const stat = statSync(this.filePath);
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        throw new CredentialStoreError("Credential file permissions are too broad; require owner-only access.");
      }
      const value = normalizeSessionCookie(readFileSync(this.filePath, "utf8").trim());
      if (!value) throw new CredentialStoreError("Credential file is empty.");
      return value;
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        if (error instanceof CredentialStoreError) throw error;
        throw new CredentialStoreError("Credential file could not be read.", error);
      }
    }
    const bootstrap = normalizeSessionCookie(environmentCookie || "");
    if (!bootstrap) return null;
    this.write(bootstrap);
    return bootstrap;
  }

  write(cookie: string): void {
    const normalized = normalizeSessionCookie(cookie);
    if (!normalized) throw new CredentialStoreError("Cannot persist an empty credential.");
    const parent = dirname(this.filePath);
    let temporary: string | null = null;
    let fd: number | null = null;
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      temporary = join(parent, `.session-cookie-${randomUUID()}.tmp`);
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, normalized, { encoding: "utf8" });
      closeSync(fd);
      fd = null;
      renameSync(temporary, this.filePath);
      if (process.platform !== "win32") chmodSync(this.filePath, 0o600);
      temporary = null;
    } catch (error) {
      try { if (fd !== null) closeSync(fd); } catch { /* already closed */ }
      try { if (temporary) unlinkSync(temporary); } catch { /* already gone */ }
      throw new CredentialStoreError("Credential file could not be updated atomically.", error);
    }
  }
}
