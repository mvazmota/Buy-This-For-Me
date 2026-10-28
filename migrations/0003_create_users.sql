-- Accounts for the dashboard and the extension.
-- Passwords are stored as PBKDF2-SHA256 hashes: pbkdf2$<iterations>$<salt>$<hash>.
-- Roles: 'admin' can edit and delete; 'user' can add and view only.

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);
