// Cloudflare Worker API + static dashboard for BIFM.
// API routes are same-origin, password-protected with the APP_PASSWORD secret,
// and store requests in D1. Everything else is served from the ASSETS binding.

import validateModule from '../lib/validate.js';
import { buildNtfyMessage, sendNtfyNotification } from './notify.js';
import {
  COOKIE_NAME,
  clearSessionCookie,
  createSessionToken,
  passwordMatches,
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

function configuredPassword(env) {
  return typeof env.APP_PASSWORD === 'string' && env.APP_PASSWORD.length > 0
    ? env.APP_PASSWORD
    : null;
}

async function isAuthenticated(request, env) {
  const password = configuredPassword(env);
  if (!password) return false;
  const token = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  return verifySessionToken(token, password);
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

async function isExtensionAuthorized(request, env) {
  const submitted = request.headers.get('x-app-password');
  if (submitted === null) return false;
  const password = configuredPassword(env);
  if (!password) return false;
  return passwordMatches(submitted, password);
}

/**
 * Fire an ntfy notification for a newly created request. The API response never
 * depends on it: with a Worker ctx the send runs after the response, and the
 * sender itself swallows every error.
 */
async function notifyNewRequest(env, created, origin, ctx) {
  try {
    if (!env || typeof env.NTFY_TOPIC !== 'string' || env.NTFY_TOPIC.trim() === '') return;
    const message = buildNtfyMessage(created, origin);
    const task = sendNtfyNotification(env, message);
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(task);
      return;
    }
    await task;
  } catch {
    // A notification problem must never affect the API response.
  }
}

async function handleRequests(request, env, url, extensionAuthorized = false, ctx = null) {
  if (!extensionAuthorized && !(await isAuthenticated(request, env))) {
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
      await notifyNewRequest(env, created, url.origin, ctx);
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
    const removed = await deleteRequest(env, id);
    if (!removed) return json({ error: 'Request not found.' }, 404);
    return json({ deleted: true, id });
  }

  if (request.method !== 'PATCH') {
    return json({ error: 'Method not allowed. Use PATCH or DELETE.' }, 405);
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

  const password = configuredPassword(env);
  if (!password) {
    // Do not reveal whether a secret exists or what it is.
    return json({ error: 'Login is not available.' }, 503);
  }

  const body = await readJsonBody(request);
  const submitted = body && typeof body === 'object' && !Array.isArray(body) ? body.password : undefined;
  if (!(await passwordMatches(submitted, password))) {
    return json({ error: 'Invalid password.' }, 401);
  }

  const token = await createSessionToken(password);
  return json({ authenticated: true, authRequired: true }, 200, {
    'Set-Cookie': sessionCookie(token),
  });
}

async function handleApi(request, env, url, ctx = null) {
  // The extension talks to /api/requests directly with the app password in the
  // X-App-Password header: it reads the list to warn about duplicates and posts
  // new requests. That header only bypasses the same-origin check and the
  // session cookie for GET/POST on that one route. PATCH and DELETE still need
  // the login cookie.
  const extensionPath =
    url.pathname === '/api/requests' &&
    (request.method === 'GET' || request.method === 'POST');
  const extensionAuthorized = extensionPath && (await isExtensionAuthorized(request, env));

  if (!extensionAuthorized && !isSameOrigin(request, url)) {
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
    return json({ authenticated: await isAuthenticated(request, env), authRequired: true });
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
    return handleRequests(request, env, url, extensionAuthorized, ctx);
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
