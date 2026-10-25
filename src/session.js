// Signed, expiring session cookies for the Cloudflare Worker.
// The only secret involved is the APP_PASSWORD Worker secret; it never leaves
// the Worker and is only used to derive the HMAC key.

const encoder = new TextEncoder();

export const COOKIE_NAME = 'bifm_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TOKEN_LENGTH = 4096;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
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

function sessionKey(password) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`bifm-session:${password}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/** Create a signed token containing only an expiry timestamp. */
export async function createSessionToken(password, now = Date.now()) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Cannot create a session without a password.');
  }
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ exp: expiresAt })));
  const key = await sessionKey(password);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Verify signature and expiry with WebCrypto. Returns a boolean, never throws. */
export async function verifySessionToken(token, password, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
    if (typeof password !== 'string' || password.length === 0) return false;

    const separator = token.indexOf('.');
    if (separator < 1 || separator !== token.lastIndexOf('.')) return false;

    const payload = token.slice(0, separator);
    const signature = base64UrlToBytes(token.slice(separator + 1));
    if (!signature || signature.length !== 32) return false;

    const key = await sessionKey(password);
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload));
    if (!valid) return false;

    const payloadBytes = base64UrlToBytes(payload);
    if (!payloadBytes) return false;
    const decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!decoded || typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp)) return false;
    return decoded.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

/**
 * Compare a submitted password to the configured one without an early exit.
 * Both values are hashed first so the comparison length is fixed.
 */
export async function passwordMatches(submitted, expected) {
  if (typeof submitted !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(submitted)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
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
