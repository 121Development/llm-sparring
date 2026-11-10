import type { DebateRecord, DebateStore } from "../core/debateStore.js";
import type { SqlDb } from "./sql.js";

export interface D1DebateStoreOptions {
  now?: () => number;
  /** Expired debates are kept this long so callers get "expired" rather than "unknown". */
  graceMs?: number;
}

/** Persistent DebateStore on D1. Reads and writes are always filtered by owner_id. */
export class D1DebateStore implements DebateStore {
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(
    private readonly db: SqlDb,
    opts: D1DebateStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.graceMs ?? 24 * 3600_000;
  }

  async create(rec: DebateRecord): Promise<void> {
    await this.db
      .prepare("DELETE FROM debates WHERE expires_at < ?")
      .bind(this.now() - this.graceMs)
      .run();
    await this.db
      .prepare("INSERT INTO debates (id, owner_id, version, updated_at, expires_at, data) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(rec.id, rec.ownerId, rec.version, rec.updatedAt, rec.expiresAt, JSON.stringify(rec))
      .run();
  }

  async get(ownerId: string, id: string): Promise<DebateRecord | null> {
    const row = await this.db
      .prepare("SELECT data FROM debates WHERE id = ? AND owner_id = ?")
      .bind(id, ownerId)
      .first<{ data: string }>();
    return row ? (JSON.parse(row.data) as DebateRecord) : null;
  }

  async update(rec: DebateRecord, expectedVersion: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE debates SET version = ?, updated_at = ?, expires_at = ?, data = ? WHERE id = ? AND owner_id = ? AND version = ?",
      )
      .bind(rec.version, rec.updatedAt, rec.expiresAt, JSON.stringify(rec), rec.id, rec.ownerId, expectedVersion)
      .run();
    return res.meta.changes === 1;
  }
}
