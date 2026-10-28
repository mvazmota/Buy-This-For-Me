// Password hashing for the Worker and the seed script.
//
// Cloudflare Workers' WebCrypto rejects PBKDF2 with NotSupportedError, so this
// uses salted SHA-256: one digest over (salt || password). It is fast enough
// for the Workers CPU budget and never stores a plain password, but it is not a
// slow KDF. Treat it as "good enough for a two-person family tool": use real
// passwords, and never reuse an important one here.
//
// Stored format: sha256$1$<salt base64url>$<digest base64url>

const SALT_BYTES = 16;
const DIGEST_BYTES = 32;
const encoder = new TextEncoder();

export const ROLES = ['admin', 'user'];
export const HASH_SCHEME = 'sha256';

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

async function digest(saltBytes, password) {
  const passwordBytes = encoder.encode(password);
  const input = new Uint8Array(saltBytes.length + passwordBytes.length);
  input.set(saltBytes, 0);
  input.set(passwordBytes, saltBytes.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** Hash a password for storage. The salt is random for every call. */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 4) {
    throw new Error('Password must be at least 4 characters.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await digest(salt, password);
  return `${HASH_SCHEME}$1$${toBase64Url(salt)}$${toBase64Url(hash)}`;
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
    if (parts.length !== 4 || parts[0] !== HASH_SCHEME) {
      console.error('password check failed: unrecognised hash format.');
      return false;
    }

    const salt = fromBase64Url(parts[2]);
    const expected = fromBase64Url(parts[3]);
    if (!salt || !expected || expected.length !== DIGEST_BYTES) return false;

    const actual = await digest(salt, password);
    return constantTimeEqual(actual, expected);
  } catch (err) {
    console.error('password check failed:', err && err.name ? err.name : 'unknown error');
    return false;
  }
}

/**
 * Look up an account by username. Returns { username, role, passwordHash } or null.
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
    // Spend roughly the same time as a real check so a missing user is not obvious.
    await digest(new Uint8Array(SALT_BYTES), password);
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? { username: user.username, role: user.role } : null;
}

export function isValidRole(value) {
  return ROLES.includes(value);
}
