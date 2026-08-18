import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ImageMetadata {
  id: string;
  sha256: string;
  mimeType: string;
  bytes: number;
  conversationId: string | null;
  parentMessageId: string | null;
  createdAt: number;
  expiresAt: number;
}

/** Persistent bounded image metadata/cache extension point; network resolution is intentionally not faked. */
export class PersistentImageCache {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  constructor(root: string, ttlMs = 1_800_000, maxBytes = 64 * 1024 * 1024, databasePath = join(root, "metadata.sqlite")) {
    this.root = root;
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS image_cache (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL, conversation_id TEXT, parent_message_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  }

  put(data: Uint8Array, mimeType: string, context?: { conversationId?: string | null; parentMessageId?: string | null }): ImageMetadata {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const id = randomUUID().replaceAll("-", "").slice(0, 32);
    const now = Date.now();
    const safeMime = /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : "application/octet-stream";
    writeFileSync(join(this.root, id), data);
    this.db.prepare("INSERT INTO image_cache VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, sha256, safeMime, data.byteLength, context?.conversationId || null, context?.parentMessageId || null, now, now + this.ttlMs);
    this.evict();
    return { id, sha256, mimeType: safeMime, bytes: data.byteLength, conversationId: context?.conversationId || null, parentMessageId: context?.parentMessageId || null, createdAt: now, expiresAt: now + this.ttlMs };
  }

  get(id: string): { metadata: ImageMetadata; data: Uint8Array } | null {
    const row: any = this.db.prepare("SELECT * FROM image_cache WHERE id = ?").get(id);
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) { this.remove(id); return null; }
    try {
      const data = readFileSync(join(this.root, id));
      return { metadata: { id: row.id, sha256: row.sha256, mimeType: row.mime_type, bytes: Number(row.bytes), conversationId: row.conversation_id, parentMessageId: row.parent_message_id, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) }, data };
    } catch { this.remove(id); return null; }
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM image_cache WHERE id = ?").run(id);
    try { unlinkSync(join(this.root, id)); } catch { /* already gone */ }
  }

  private evict(): void {
    const now = Date.now();
    for (const row of this.db.prepare("SELECT id FROM image_cache WHERE expires_at <= ?").all(now) as any[]) this.remove(String(row.id));
    let total = Number((this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM image_cache").get() as any).total);
    for (const row of this.db.prepare("SELECT id, bytes FROM image_cache ORDER BY created_at ASC").all() as any[]) {
      if (total <= this.maxBytes) break;
      total -= Number(row.bytes);
      this.remove(String(row.id));
    }
  }

  close(): void { this.db.close(); }
}

export interface ImageResolver {
  resolve(pointer: string, conversationId: string | null, parentMessageId: string | null, signal?: AbortSignal): Promise<string | null>;
}

/** Native WebSocket/poll image resolution is intentionally an injectable future extension. */
export class UnconfiguredImageResolver implements ImageResolver {
  async resolve(): Promise<string | null> { return null; }
}
