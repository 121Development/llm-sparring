/**
 * Persistence for debates. The only place any tool writes.
 * Local: InMemoryDebateStore. Hosted: D1 / Durable Object implementation (Phase 3).
 */

export type Speaker = "claude" | "gpt";

export interface DebateTurn {
  speaker: Speaker;
  /** 0 = opening statements, 1..maxRounds = rebuttal rounds. */
  round: number;
  text: string;
}

export interface StoredVerdict {
  /** Which real speaker was shown to the judge as side A. */
  sideA: Speaker;
  /** Formatted verdict text (A/B already mapped back to Claude/GPT). */
  text: string;
  structured: Record<string, unknown>;
}

export type DebateStatus = "open" | "rounds_complete" | "closed";

export interface DebateRecord {
  id: string;
  ownerId: string;
  question: string;
  maxRounds: number;
  roundsCompleted: number;
  status: DebateStatus;
  turns: DebateTurn[];
  verdict?: StoredVerdict;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Incremented on each write; used for optimistic concurrency. */
  version: number;
}

export interface DebateStore {
  create(rec: DebateRecord): Promise<void>;
  /** Returns the record only if it exists and belongs to ownerId (expired records may still be returned). */
  get(ownerId: string, id: string): Promise<DebateRecord | null>;
  /** Writes rec if the stored version equals expectedVersion. Returns false on conflict. */
  update(rec: DebateRecord, expectedVersion: number): Promise<boolean>;
}

export interface InMemoryDebateStoreOptions {
  now?: () => number;
  /** Expired records are kept this long so callers get "expired" rather than "unknown". */
  graceMs?: number;
  /** Cap on stored debates; oldest-updated are evicted first. */
  maxDebates?: number;
}

export class InMemoryDebateStore implements DebateStore {
  private readonly map = new Map<string, DebateRecord>();
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxDebates: number;

  constructor(opts: InMemoryDebateStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.graceMs ?? 24 * 3600_000;
    this.maxDebates = opts.maxDebates ?? 1000;
  }

  async create(rec: DebateRecord): Promise<void> {
    this.sweep();
    if (this.map.has(rec.id)) throw new Error("duplicate debate id");
    this.map.set(rec.id, structuredClone(rec));
  }

  async get(ownerId: string, id: string): Promise<DebateRecord | null> {
    const rec = this.map.get(id);
    if (!rec || rec.ownerId !== ownerId) return null;
    return structuredClone(rec);
  }

  async update(rec: DebateRecord, expectedVersion: number): Promise<boolean> {
    const cur = this.map.get(rec.id);
    if (!cur || cur.ownerId !== rec.ownerId || cur.version !== expectedVersion) return false;
    this.map.set(rec.id, structuredClone(rec));
    return true;
  }

  get size(): number {
    return this.map.size;
  }

  private sweep() {
    const t = this.now();
    for (const [id, rec] of this.map) {
      if (rec.expiresAt + this.graceMs < t) this.map.delete(id);
    }
    if (this.map.size >= this.maxDebates) {
      const oldest = [...this.map.values()].sort((a, b) => a.updatedAt - b.updatedAt);
      for (const rec of oldest.slice(0, this.map.size - this.maxDebates + 1)) this.map.delete(rec.id);
    }
  }
}
