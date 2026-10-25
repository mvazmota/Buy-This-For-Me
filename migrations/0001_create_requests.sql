-- Requests stored by the Cloudflare Worker (D1 / SQLite).
-- Idempotent so applying it twice is harmless.

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999),
  status TEXT NOT NULL DEFAULT 'New'
    CHECK (status IN ('New', 'Purchased', 'Done', 'Not buying')),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS requests_submitted_at_idx
  ON requests (submitted_at DESC);
