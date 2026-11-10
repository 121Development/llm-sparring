import type { SqlDb } from "./sql.js";

export interface LoginLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * Fixed-window failed sign-in counter in D1. Locks a key (username or IP)
 * after maxFailures within windowMs. Success clears the username key.
 */
export class LoginLimiter {
  readonly maxFailures: number;
  readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: SqlDb,
    opts: LoginLimiterOptions = {},
  ) {
    this.maxFailures = opts.maxFailures ?? 10;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async isLocked(keys: string[]): Promise<boolean> {
    const t = this.now();
    for (const key of keys) {
      const row = await this.db
        .prepare("SELECT failures, window_start FROM login_failures WHERE key = ?")
        .bind(key)
        .first<{ failures: number; window_start: number }>();
      if (row && t - row.window_start < this.windowMs && row.failures >= this.maxFailures) return true;
    }
    return false;
  }

  async recordFailure(keys: string[]): Promise<void> {
    const t = this.now();
    for (const key of keys) {
      // Start a new window if the old one has passed, otherwise increment.
      await this.db
        .prepare(
          `INSERT INTO login_failures (key, failures, window_start) VALUES (?1, 1, ?2)
           ON CONFLICT(key) DO UPDATE SET
             failures = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE failures + 1 END,
             window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
        )
        .bind(key, t, this.windowMs)
        .run();
    }
  }

  async clear(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM login_failures WHERE key = ?").bind(key).run();
  }
}
