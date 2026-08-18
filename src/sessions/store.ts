import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TurnState = "idle" | "in_flight" | "uncertain" | "reconciling";

export interface SessionState {
  accountKeyHash: string;
  sessionKey: string;
  conversationId: string | null;
  parentMessageId: string | null;
  modelSlug: string | null;
  turnState: TurnState;
  lastInputHash: string | null;
  lastMessageId: string | null;
  handoffToken: string | null;
  uncertainSince: number | null;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export function hashInput(messages: unknown): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function rowToState(row: any): SessionState {
  return {
    accountKeyHash: String(row.account_key_hash),
    sessionKey: String(row.session_key),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    parentMessageId: row.parent_message_id == null ? null : String(row.parent_message_id),
    modelSlug: row.model_slug == null ? null : String(row.model_slug),
    turnState: String(row.turn_state) as TurnState,
    lastInputHash: row.last_input_hash == null ? null : String(row.last_input_hash),
    lastMessageId: row.last_message_id == null ? null : String(row.last_message_id),
    handoffToken: row.handoff_token == null ? null : String(row.handoff_token),
    uncertainSince: row.uncertain_since == null ? null : Number(row.uncertain_since),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    version: Number(row.version),
  };
}

/** Durable conversation state. DatabaseSync keeps the commit boundary synchronous and explicit. */
export class SessionStore {
  readonly db: DatabaseSync;
  readonly path: string;
  constructor(path: string, accountKey: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        account_key_hash TEXT NOT NULL,
        session_key TEXT NOT NULL,
        conversation_id TEXT,
        parent_message_id TEXT,
        model_slug TEXT,
        turn_state TEXT NOT NULL DEFAULT 'idle',
        last_input_hash TEXT,
        last_message_id TEXT,
        handoff_token TEXT,
        uncertain_since INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (account_key_hash, session_key)
      );
      CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(account_key_hash, updated_at);
    `);
    this.accountKeyHash = createHash("sha256").update(accountKey).digest("hex").slice(0, 32);
  }

  private readonly accountKeyHash: string;

  get(sessionKey: string): SessionState | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE account_key_hash = ? AND session_key = ?").get(this.accountKeyHash, sessionKey);
    return row ? rowToState(row) : null;
  }

  getOrCreate(sessionKey: string): SessionState {
    const existing = this.get(sessionKey);
    if (existing) return existing;
    const now = Date.now();
    this.db.prepare(`INSERT INTO sessions (account_key_hash, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(this.accountKeyHash, sessionKey, now, now);
    return this.get(sessionKey)!;
  }

  markInFlight(sessionKey: string, input: unknown, modelSlug: string, handoffToken: string | null = null): SessionState {
    const current = this.getOrCreate(sessionKey);
    const now = Date.now();
    this.db.prepare(`UPDATE sessions SET turn_state = 'in_flight', model_slug = ?, last_input_hash = ?, handoff_token = ?, uncertain_since = NULL, updated_at = ?, version = version + 1 WHERE account_key_hash = ? AND session_key = ?`)
      .run(modelSlug, hashInput(input), handoffToken, now, this.accountKeyHash, sessionKey);
    return this.get(sessionKey) || current;
  }

  markUncertain(sessionKey: string, reason = "unknown"): SessionState {
    const now = Date.now();
    this.db.prepare(`UPDATE sessions SET turn_state = 'uncertain', handoff_token = ?, uncertain_since = ?, updated_at = ?, version = version + 1 WHERE account_key_hash = ? AND session_key = ?`)
      .run(reason.slice(0, 256), now, now, this.accountKeyHash, sessionKey);
    return this.get(sessionKey)!;
  }

  markReconciling(sessionKey: string): SessionState {
    const now = Date.now();
    this.db.prepare(`UPDATE sessions SET turn_state = 'reconciling', updated_at = ?, version = version + 1 WHERE account_key_hash = ? AND session_key = ?`)
      .run(now, this.accountKeyHash, sessionKey);
    return this.get(sessionKey)!;
  }

  markIdle(sessionKey: string): SessionState {
    const now = Date.now();
    this.db.prepare(`UPDATE sessions SET turn_state = 'idle', handoff_token = NULL, uncertain_since = NULL, updated_at = ?, version = version + 1 WHERE account_key_hash = ? AND session_key = ?`)
      .run(now, this.accountKeyHash, sessionKey);
    return this.get(sessionKey)!;
  }

  markCompleted(sessionKey: string, result: { conversationId: string | null; parentMessageId: string | null; modelSlug: string; messageId?: string | null; input: unknown }): SessionState {
    this.getOrCreate(sessionKey);
    const now = Date.now();
    this.db.prepare(`UPDATE sessions SET conversation_id = ?, parent_message_id = ?, model_slug = ?, turn_state = 'idle', last_input_hash = ?, last_message_id = ?, handoff_token = NULL, uncertain_since = NULL, updated_at = ?, version = version + 1 WHERE account_key_hash = ? AND session_key = ?`)
      .run(result.conversationId, result.parentMessageId, result.modelSlug, hashInput(result.input), result.messageId || null, now, this.accountKeyHash, sessionKey);
    return this.get(sessionKey)!;
  }

  /** Reset continuation without deleting audit-safe row metadata. */
  reset(sessionKey: string): SessionState {
    this.getOrCreate(sessionKey);
    const now = Date.now();
    this.db.prepare(`UPDATE sessions SET conversation_id = NULL, parent_message_id = NULL, model_slug = NULL, turn_state = 'idle', last_input_hash = NULL, last_message_id = NULL, handoff_token = NULL, uncertain_since = NULL, updated_at = ?, version = version + 1 WHERE account_key_hash = ? AND session_key = ?`)
      .run(now, this.accountKeyHash, sessionKey);
    return this.getOrCreate(sessionKey);
  }

  list(): SessionState[] {
    return this.db.prepare("SELECT * FROM sessions WHERE account_key_hash = ? ORDER BY updated_at DESC").all(this.accountKeyHash).map(rowToState);
  }

  close(): void { this.db.close(); }
}
