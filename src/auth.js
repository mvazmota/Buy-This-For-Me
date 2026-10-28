// Password hashing for the Worker and the seed script.
// PBKDF2-SHA256 with a random per-user salt, stored as one string:
//   pbkdf2$<iterations>$<salt base64url>$<key base64url>
// Nothing here logs a password.

const PBKDF2_ITERATIONS = 120000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const encoder = new TextEncoder();

export const ROLES = ['admin', 'user'];

// 3-32 chars, lowercase letters, digits, dot, underscore, dash.
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidUsername(value) {
  return typeof value === 'string' && USERNAME_PATTERN.test(value);
}

function derive(password, salt, iterations) {
  return crypto.subtle
    .importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
    .then((baseKey) =>
      crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        baseKey,
        KEY_BYTES * 8
      )
    );
}

/** Hash a password for storage. The salt is random for every call. */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 4) {
    throw new Error('Password must be at least 4 characters.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

function constantTimeEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

/** Check a password against a stored hash. Never throws. */
export async function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || !password) return false;
    if (typeof stored !== 'string') return false;

    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1000000) return false;

    const salt = fromBase64Url(parts[2]);
    const expected = fromBase64Url(parts[3]);
    if (!salt || !expected || expected.length !== KEY_BYTES) return false;

    const bits = await derive(password, salt, iterations);
    return constantTimeEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}

/**
 * Look up an account by username. Returns { username, role } or null.
 * Needs the D1 `users` table; any query error is a miss, never a 500 leak.
 */
export async function findUser(env, username) {
  const normalized = normalizeUsername(username);
  if (!isValidUsername(normalized)) return null;
  if (!env || !env.DB || typeof env.DB.prepare !== 'function') return null;

  try {
    const row = await env.DB.prepare(
      'SELECT username, password_hash, role FROM users WHERE username = ?'
    )
      .bind(normalized)
      .first();
    if (!row) return null;
    if (!ROLES.includes(row.role)) return null;
    return { username: row.username, role: row.role, passwordHash: row.password_hash };
  } catch {
    return null;
  }
}

/** Verify a username/password pair against D1. Returns { username, role } or null. */
export async function authenticate(env, username, password) {
  const user = await findUser(env, username);
  if (!user) {
    // Still run a hash so a missing user takes about as long as a wrong password.
    await verifyPassword(password, `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(new Uint8Array(SALT_BYTES))}$${toBase64Url(new Uint8Array(KEY_BYTES))}`);
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? { username: user.username, role: user.role } : null;
}

export function isValidRole(value) {
  return ROLES.includes(value);
}
