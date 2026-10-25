// Cloudflare Worker API + static dashboard for BIFM.
// API routes are same-origin, password-protected with the APP_PASSWORD secret,
// and store requests in D1. Everything else is served from the ASSETS binding.

import validateModule from '../lib/validate.js';
import {
  COOKIE_NAME,
  clearSessionCookie,
  createSessionToken,
  passwordMatches,
  readCookie,
  sessionCookie,
  verifySessionToken,
} from './session.js';

const { validateNewRequest, validateStatusUpdate } = validateModule;

const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_COLUMNS = 'id, title, url, note, quantity, status, submitted_at, updated_at';
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
    status: 'New',
    submittedAt: now,
    updatedAt: now,
  };

  await env.DB.prepare(
    'INSERT INTO requests (id, title, url, note, quantity, status, submitted_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      request.id,
      request.title,
      request.url,
      request.note,
      request.quantity,
      request.status,
      request.submittedAt,
      request.updatedAt
    )
    .run();

  return request;
}

async function updateStatus(env, id, status) {
  const existing = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`)
    .bind(id)
    .first();
  if (!existing) return null;

  const updatedAt = new Date().toISOString();
  await env.DB.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, updatedAt, id)
    .run();

  return { ...rowToRequest(existing), status, updatedAt };
}

async function handleRequests(request, env, url) {
  if (!(await isAuthenticated(request, env))) {
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
      return json({ request: await createRequest(env, result.value) }, 201);
    }
    return json({ error: 'Method not allowed. Use GET or POST.' }, 405);
  }

  const match = url.pathname.match(/^\/api\/requests\/([^/]+)$/);
  if (!match) return json({ error: 'API route not found.' }, 404);

  if (request.method !== 'PATCH') {
    return json({ error: 'Method not allowed. Use PATCH.' }, 405);
  }

  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return json({ error: 'Malformed request URL.' }, 400);
  }

  const body = await readJsonBody(request);
  const result = validateStatusUpdate(body);
  if (!result.ok) {
    return json({ error: 'Please fix the highlighted fields.', details: result.errors }, 400);
  }

  const updated = await updateStatus(env, id, result.value);
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

async function handleApi(request, env, url) {
  if (!isSameOrigin(request, url)) {
    return json({ error: 'Cross-origin requests are not allowed.' }, 403);
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
    return handleRequests(request, env, url);
  }

  return json({ error: 'API route not found.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      if (!env || !env.ASSETS) {
        return json({ error: 'Static assets are not configured.' }, 500);
      }
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof ApiError) {
        return json({ error: err.message }, err.status);
      }
      console.error('Worker API error:', err && err.message ? err.message : 'unknown error');
      return json({ error: 'Internal server error.' }, 500);
    }
  },
};
