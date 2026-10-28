// Signed, expiring session cookies carrying the account name and role.
// The HMAC key comes from the SESSION_SECRET Worker secret; it never leaves
// the Worker and is never logged.

import { toBase64Url, fromBase64Url, isValidRole, normalizeUsername } from './auth.js';

const encoder = new TextEncoder();

export const COOKIE_NAME = 'bifm_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TOKEN_LENGTH = 4096;

function sessionKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`bifm-session:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Build a signed token for one account.
 * @param {{username: string, role: string}} account
 * @param {string} secret
 */
export async function createSessionToken(account, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('Cannot create a session without a secret.');
  }
  const username = normalizeUsername(account && account.username);
  const role = account && account.role;
  if (!username || !isValidRole(role)) {
    throw new Error('Cannot create a session without a valid account.');
  }

  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = toBase64Url(encoder.encode(JSON.stringify({ u: username, r: role, exp: expiresAt })));
  const key = await sessionKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verify signature and expiry. Returns { username, role } or null.
 * Never throws.
 */
export async function verifySessionToken(token, secret, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    if (typeof secret !== 'string' || secret.length === 0) return null;

    const separator = token.indexOf('.');
    if (separator < 1 || separator !== token.lastIndexOf('.')) return null;

    const payload = token.slice(0, separator);
    const signature = fromBase64Url(token.slice(separator + 1));
    if (!signature || signature.length !== 32) return null;

    const key = await sessionKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload));
    if (!valid) return null;

    const payloadBytes = fromBase64Url(payload);
    if (!payloadBytes) return null;

    const decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!decoded || typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp)) return null;
    if (decoded.exp <= Math.floor(now / 1000)) return null;

    const username = normalizeUsername(decoded.u);
    if (!username || !isValidRole(decoded.r)) return null;

    return { username, role: decoded.r };
  } catch {
    return null;
  }
}

export function readCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
