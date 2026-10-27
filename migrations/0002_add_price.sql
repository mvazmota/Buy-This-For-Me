-- Add an optional price to requests (D1 / SQLite).
-- SQLite's ALTER TABLE ADD COLUMN has no IF NOT EXISTS form, so this migration
-- is intentionally plain and must be applied exactly once. Wrangler tracks
-- applied migrations in d1_migrations, so re-running the command is safe.
-- Existing rows get NULL, meaning "no price".

ALTER TABLE requests ADD COLUMN price REAL;
