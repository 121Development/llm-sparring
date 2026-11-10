-- Debates, scoped per user. The full record is JSON in `data`; columns used for
-- lookups, ownership, concurrency and expiry are duplicated outside it.
CREATE TABLE IF NOT EXISTS debates (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS debates_owner ON debates (owner_id);
CREATE INDEX IF NOT EXISTS debates_expires ON debates (expires_at);

-- Failed sign-in counters for brute-force protection. key = "user:<name>" or "ip:<addr>".
CREATE TABLE IF NOT EXISTS login_failures (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
