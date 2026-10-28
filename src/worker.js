// Cloudflare Worker API + static dashboard for BIFM.
// API routes are same-origin and store requests in D1. Accounts live in the
// `users` table: a session cookie (HMAC-signed with SESSION_SECRET) carries the
// username and role. Admins can edit and delete; users can add and view.

import validateModule from '../lib/validate.js';
import { authenticate, normalizeUsername } from './auth.js';
import { notifyNewRequest } from './notify.js';
import {
  COOKIE_NAME,
  clearSessionCookie,
  createSessionToken,
  readCookie,
  sessionCookie,
  verifySessionToken,
} from './session.js';

const { validateNewRequest, validateRequestUpdate } = validateModule;

const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_COLUMNS = 'id, title, url, note, quantity, price, status, submitted_at, updated_at';
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function rowToRequest(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    note: row.note,
    quantity: row.quantity,
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

async function readJsonBody(request) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isFinite(size) || size < 0) {
      throw new ApiError(400, 'Request body is not valid JSON.');
    }
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'Request body is too large (limit 64 KB).');
    }
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    throw new ApiError(400, 'Request body is not valid JSON.');
  }

  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, 'Request body is too large (limit 64 KB).');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ApiError(400, 'Request body must be JSON.');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ApiError(400, 'Request body is not valid JSON.');
  }
}

function isSameOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

function configuredSecret(env) {
  return typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length > 0
    ? env.SESSION_SECRET
    : null;
}

/** Current session as { username, role }, or null. */
async function getSession(request, env) {
  const secret = configuredSecret(env);
  if (!secret) return null;
  const token = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  return verifySessionToken(token, secret);
}

function isAdmin(session) {
  return Boolean(session && session.role === 'admin');
}

async function listRequests(env) {
  const result = await env.DB.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM requests ORDER BY submitted_at DESC, rowid DESC`
  ).all();
  return (result.results || []).map(rowToRequest);
}

async function createRequest(env, value) {
  const now = new Date().toISOString();
  const request = {
    id: crypto.randomUUID(),
    title: value.title,
    url: value.url,
    note: value.note,
    quantity: value.quantity,
    price: value.price === undefined ? null : value.price,
    status: 'New',
    submittedAt: now,
    updatedAt: now,
  };

  await env.DB.prepare(
    'INSERT INTO requests (id, title, url, note, quantity, price, status, submitted_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      request.id,
      request.title,
      request.url,
      request.note,
      request.quantity,
      request.price,
      request.status,
      request.submittedAt,
      request.updatedAt
    )
    .run();

  return request;
}

async function updateRequest(env, id, changes) {
  const existing = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`)
    .bind(id)
    .first();
  if (!existing) return null;

  const updated = {
    ...rowToRequest(existing),
    ...changes,
    updatedAt: new Date().toISOString(),
  };

  await env.DB.prepare(
    'UPDATE requests SET title = ?, url = ?, note = ?, quantity = ?, price = ?, status = ?, ' +
      'updated_at = ? WHERE id = ?'
  )
    .bind(
      updated.title,
      updated.url,
      updated.note,
      updated.quantity,
      updated.price,
      updated.status,
      updated.updatedAt,
      id
    )
    .run();

  return updated;
}

async function deleteRequest(env, id) {
  // Check existence first so a missing id is a clean 404 even if the DELETE
  // itself reports zero changed rows.
  const existing = await env.DB.prepare('SELECT id FROM requests WHERE id = ?').bind(id).first();
  if (!existing) return false;

  const result = await env.DB.prepare('DELETE FROM requests WHERE id = ?').bind(id).run();
  const changes = result && result.meta ? Number(result.meta.changes) : 0;
  return changes > 0;
}

/**
 * Authenticate the extension with its own credentials. The extension cannot
 * hold a session cookie, so it sends X-App-Username and X-App-Password and gets
 * read/add access only. PATCH and DELETE always need the dashboard cookie.
 */
async function authenticateExtension(request, env) {
  const username = request.headers.get('x-app-username');
  const password = request.headers.get('x-app-password');
  if (username === null || password === null) return null;
  return authenticate(env, username, password);
}

/**
 * Fire notifications for a newly created request. The API response never
 * depends on them: with a Worker ctx the send runs after the response, and the
 * notifier itself swallows every error.
 */
async function notifyCreated(env, created, origin, ctx) {
  try {
    const hasNtfy = typeof env.NTFY_TOPIC === 'string' && env.NTFY_TOPIC.trim() !== '';
    const hasDiscord =
      typeof env.DISCORD_WEBHOOK_URL === 'string' && env.DISCORD_WEBHOOK_URL.trim() !== '';
    if (!hasNtfy && !hasDiscord) return;

    const task = notifyNewRequest(env, created, origin);
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(task);
      return;
    }
    await task;
  } catch {
    // A notification problem must never affect the API response.
  }
}

async function handleRequests(request, env, url, session = null, ctx = null) {
  if (!session) {
    return json({ error: 'Authentication required.' }, 401);
  }

  if (url.pathname === '/api/requests') {
    if (request.method === 'GET') {
      return json({ requests: await listRequests(env) });
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      const result = validateNewRequest(body);
      if (!result.ok) {
        return json({ error: 'Please fix the highlighted fields.', details: result.errors }, 400);
      }
      const created = await createRequest(env, result.value);
      await notifyCreated(env, created, url.origin, ctx);
      return json({ request: created }, 201);
    }
    return json({ error: 'Method not allowed. Use GET or POST.' }, 405);
  }

  const match = url.pathname.match(/^\/api\/requests\/([^/]+)$/);
  if (!match) return json({ error: 'API route not found.' }, 404);

  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return json({ error: 'Malformed request URL.' }, 400);
  }

  if (request.method === 'DELETE') {
    if (!isAdmin(session)) {
      return json({ error: 'Only an admin can delete requests.' }, 403);
    }
    const removed = await deleteRequest(env, id);
    if (!removed) return json({ error: 'Request not found.' }, 404);
    return json({ deleted: true, id });
  }

  if (request.method !== 'PATCH') {
    return json({ error: 'Method not allowed. Use PATCH or DELETE.' }, 405);
  }

  if (!isAdmin(session)) {
    return json({ error: 'Only an admin can edit requests.' }, 403);
  }

  const body = await readJsonBody(request);
  const result = validateRequestUpdate(body);
  if (!result.ok) {
    return json({ error: 'Please fix the highlighted fields.', details: result.errors }, 400);
  }

  const updated = await updateRequest(env, id, result.value);
  if (!updated) return json({ error: 'Request not found.' }, 404);
  return json({ request: updated });
}

async function handleLogin(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed. Use POST.' }, 405);
  }

  const secret = configuredSecret(env);
  if (!secret) {
    // Do not reveal whether configuration is missing or what it is.
    return json({ error: 'Login is not available.' }, 503);
  }

  const body = await readJsonBody(request);
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const username = normalizeUsername(payload.username);
  const password = typeof payload.password === 'string' ? payload.password : '';

  if (!username || !password) {
    return json({ error: 'Enter your username and password.' }, 400);
  }

  const account = await authenticate(env, username, password);
  if (!account) {
    return json({ error: 'Invalid username or password.' }, 401);
  }

  const token = await createSessionToken(account, secret);
  return json(
    { authenticated: true, authRequired: true, username: account.username, role: account.role },
    200,
    { 'Set-Cookie': sessionCookie(token) }
  );
}

async function handleApi(request, env, url, ctx = null) {
  // The extension posts with X-App-Username and X-App-Password: it can read the
  // list (duplicate warning) and add requests only. PATCH and DELETE always need
  // the dashboard session cookie.
  const extensionPath =
    url.pathname === '/api/requests' &&
    (request.method === 'GET' || request.method === 'POST');
  const extensionAccount = extensionPath ? await authenticateExtension(request, env) : null;

  if (!extensionAccount && !isSameOrigin(request, url)) {
    return extensionPath
      ? json({ error: 'Authentication required.' }, 401)
      : json({ error: 'Cross-origin requests are not allowed.' }, 403);
  }

  if (url.pathname === '/api/health') {
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed. Use GET.' }, 405);
    }
    return json({ ok: true });
  }

  if (url.pathname === '/api/session') {
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed. Use GET.' }, 405);
    }
    const session = await getSession(request, env);
    return json({
      authenticated: Boolean(session),
      authRequired: true,
      username: session ? session.username : null,
      role: session ? session.role : null,
    });
  }

  if (url.pathname === '/api/login') {
    return handleLogin(request, env);
  }

  if (url.pathname === '/api/logout') {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed. Use POST.' }, 405);
    }
    return json({ authenticated: false, authRequired: true }, 200, {
      'Set-Cookie': clearSessionCookie(),
    });
  }

  if (url.pathname === '/api/requests' || url.pathname.startsWith('/api/requests/')) {
    const session = extensionAccount || (await getSession(request, env));
    return handleRequests(request, env, url, session, ctx);
  }

  return json({ error: 'API route not found.' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      if (!env || !env.ASSETS) {
        return json({ error: 'Static assets are not configured.' }, 500);
      }
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApi(request, env, url, ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        return json({ error: err.message }, err.status);
      }
      console.error('Worker API error:', err && err.message ? err.message : 'unknown error');
      return json({ error: 'Internal server error.' }, 500);
    }
  },
};
