'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const WORKER_URL = 'https://buy-this-for-me.example.workers.dev';
const PASSWORD = 'correct horse battery staple';
const SESSION_SECRET = 'test-session-secret-9f3a';
// Precomputed salted SHA-256 hashes so the fake D1 has accounts without an async setup.
const ADMIN_PASSWORD_HASH =
  'sha256$1$SRpZUvw94oNzc7COfmIhGA$_fgcbAay0z7mLYAuZ_IYjGoyl4eSJ9mEYtxIBT0VxoY';
const MEMBER_PASSWORD_HASH =
  'sha256$1$fQ9D6yZxAvNdyJGnk7fcGA$h0xJoapA1ZJtO7-cXQg94wFQA9FM5kpUenPirFdB9lc';

// Node 18 does not expose global WebCrypto by default; the Worker tests need it.
const hasWebCrypto = Boolean(globalThis.crypto && globalThis.crypto.subtle);
const workerTest = hasWebCrypto ? test : test.skip;

const loadWorker = () => import('../src/worker.js');
const loadSession = () => import('../src/session.js');

async function readJson(response) {
  return response.json();
}

function login(password = PASSWORD, username = 'martin') {
  return new Request(`${WORKER_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

/** Extension credentials: the member account sends requests without a cookie. */
function extensionHeaders(password = '1234', username = 'alex') {
  return { 'X-App-Username': username, 'X-App-Password': password };
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

/** Tiny D1 stand-in that understands the Worker's SQL statements. */
function createFakeD1() {
  const rows = [];
  const users = [
    {
      username: 'martin',
      password_hash: ADMIN_PASSWORD_HASH,
      role: 'admin',
      created_at: '2026-10-01T00:00:00.000Z',
    },
    {
      username: 'alex',
      password_hash: MEMBER_PASSWORD_HASH,
      role: 'user',
      created_at: '2026-10-01T00:00:00.000Z',
    },
  ];

  return {
    rows,
    users,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async all() {
          if (/FROM requests/i.test(sql)) {
            return {
              results: [...rows].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)),
            };
          }
          throw new Error(`Unexpected all() query: ${sql}`);
        },
        async first() {
          if (/FROM users WHERE username = \?/i.test(sql)) {
            return users.find((user) => user.username === args[0]) || null;
          }
          if (/FROM requests WHERE id = \?/i.test(sql)) {
            return rows.find((row) => row.id === args[0]) || null;
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async run() {
          if (/^INSERT INTO requests/i.test(sql)) {
            rows.push({
              id: args[0],
              title: args[1],
              url: args[2],
              note: args[3],
              quantity: args[4],
              price: args[5],
              status: args[6],
              submitted_at: args[7],
              updated_at: args[8],
            });
            return { meta: { changes: 1 } };
          }
          if (/^UPDATE requests SET title = \?/i.test(sql)) {
            const row = rows.find((entry) => entry.id === args[7]);
            if (!row) return { meta: { changes: 0 } };
            row.title = args[0];
            row.url = args[1];
            row.note = args[2];
            row.quantity = args[3];
            row.price = args[4];
            row.status = args[5];
            row.updated_at = args[6];
            return { meta: { changes: 1 } };
          }
          if (/^UPDATE requests SET status = \?/i.test(sql)) {
            const row = rows.find((entry) => entry.id === args[2]);
            if (!row) return { meta: { changes: 0 } };
            row.status = args[0];
            row.updated_at = args[1];
            return { meta: { changes: 1 } };
          }
          if (/^DELETE FROM requests WHERE id = \?/i.test(sql)) {
            const index = rows.findIndex((entry) => entry.id === args[0]);
            if (index === -1) return { meta: { changes: 0 } };
            rows.splice(index, 1);
            return { meta: { changes: 1 } };
          }
          throw new Error(`Unexpected run() query: ${sql}`);
        },
      };
    },
  };
}

function envWithDb(extra = {}) {
  return {
    SESSION_SECRET,
    DB: createFakeD1(),
    ASSETS: { fetch: async () => new Response('asset') },
    ...extra,
  };
}

/** Collect the ntfy POSTs the Worker makes through the global fetch. */
function createFakeNtfyFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    return response;
  };
  impl.calls = calls;
  return impl;
}

/** The Worker sends ntfy through the global fetch, so swap it for the test. */
async function withFakeFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function quietly(fn) {
  const original = console.error;
  const messages = [];
  console.error = (...args) => messages.push(args.join(' '));
  try {
    const value = await fn();
    return { value, messages };
  } finally {
    console.error = original;
  }
}

workerTest('session tokens are signed, expiring and tamper-evident', async () => {
  const { createSessionToken, verifySessionToken, SESSION_TTL_SECONDS } = await loadSession();
  const account = { username: 'martin', role: 'admin' };

  const token = await createSessionToken(account, SESSION_SECRET);
  assert.deepEqual(await verifySessionToken(token, SESSION_SECRET), {
    username: 'martin',
    role: 'admin',
  });
  assert.equal(await verifySessionToken(token, 'wrong secret'), null);
  assert.equal(await verifySessionToken(`${token}x`, SESSION_SECRET), null);
  assert.equal(await verifySessionToken('not-a-token', SESSION_SECRET), null);
  assert.equal(await verifySessionToken(token, ''), null);

  // A role change must not be forgeable: the payload is signed.
  const memberToken = await createSessionToken({ username: 'alex', role: 'user' }, SESSION_SECRET);
  const [payload, signature] = memberToken.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ u: 'alex', r: 'admin', exp: 9999999999 }))
    .toString('base64url');
  assert.equal(await verifySessionToken(`${forgedPayload}.${signature}`, SESSION_SECRET), null);
  assert.equal(await verifySessionToken(memberToken, SESSION_SECRET).then((s) => s.role), 'user');

  const expired = await createSessionToken(
    account,
    SESSION_SECRET,
    Date.now() - (SESSION_TTL_SECONDS + 60) * 1000
  );
  assert.equal(await verifySessionToken(expired, SESSION_SECRET), null);
});

workerTest('health is public and request APIs require auth', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const health = await worker.fetch(new Request(`${WORKER_URL}/api/health`), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await readJson(health), { ok: true });

  for (const request of [
    new Request(`${WORKER_URL}/api/requests`),
    new Request(`${WORKER_URL}/api/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A', url: 'https://example.com' }),
    }),
  ]) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 401);
    assert.deepEqual(await readJson(response), { error: 'Authentication required.' });
  }
});

workerTest('login rejects wrong passwords with a generic error and no cookie', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const response = await worker.fetch(login('wrong password'), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await readJson(response), { error: 'Invalid username or password.' });
  assert.equal(response.headers.get('set-cookie'), null);

  const unknown = await worker.fetch(login(PASSWORD, 'nobody'), env);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await readJson(unknown), { error: 'Invalid username or password.' });
});

workerTest('login sets an HttpOnly, Secure, SameSite=Lax session cookie', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const response = await worker.fetch(login(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    authenticated: true,
    authRequired: true,
    username: 'martin',
    role: 'admin',
  });

  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, /^bifm_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=604800/);

  const session = await worker.fetch(
    new Request(`${WORKER_URL}/api/session`, { headers: { Cookie: cookieFrom(response) } }),
    env
  );
  assert.equal(session.status, 200);
  assert.deepEqual(await readJson(session), {
    authenticated: true,
    authRequired: true,
    username: 'martin',
    role: 'admin',
  });
});

workerTest('logout clears the session cookie', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const response = await worker.fetch(new Request(`${WORKER_URL}/api/logout`, { method: 'POST' }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { authenticated: false, authRequired: true });
  assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/);
});

workerTest('cross-origin API requests are rejected', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const request = new Request(`${WORKER_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ username: 'martin', password: PASSWORD }),
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 403);
  assert.match((await readJson(response)).error, /Cross-origin/);
});

workerTest('a member can add and read but cannot edit or delete', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb({ NTFY_TOPIC: '' });

  const memberLogin = await worker.fetch(login('1234', 'alex'), env);
  assert.equal(memberLogin.status, 200);
  assert.equal((await readJson(memberLogin)).role, 'user');
  const cookie = cookieFrom(memberLogin);

  const created = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'Book', url: 'https://example.com/book' }),
    }),
    env
  );
  assert.equal(created.status, 201);
  const { request } = await readJson(created);

  const listed = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, { headers: { Cookie: cookie } }),
    env
  );
  assert.equal(listed.status, 200);

  const patched = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/${request.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'Done' }),
    }),
    env
  );
  assert.equal(patched.status, 403);
  assert.match((await readJson(patched)).error, /admin/i);

  const removed = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/${request.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }),
    env
  );
  assert.equal(removed.status, 403);

  // The row is untouched.
  assert.equal(env.DB.rows.length, 1);
  assert.equal(env.DB.rows[0].status, 'New');
});

workerTest('an admin can edit and delete', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb({ NTFY_TOPIC: '' });

  const adminLogin = await worker.fetch(login(), env);
  const cookie = cookieFrom(adminLogin);

  const created = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'Book', url: 'https://example.com/book' }),
    }),
    env
  );
  const { request } = await readJson(created);

  const patched = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/${request.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'Done' }),
    }),
    env
  );
  assert.equal(patched.status, 200);

  const removed = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/${request.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }),
    env
  );
  assert.equal(removed.status, 200);
  assert.equal(env.DB.rows.length, 0);
});

workerTest('extension headers cannot edit or delete even for an admin account', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb({ NTFY_TOPIC: '' });

  const response = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/anything`, {
      method: 'DELETE',
      headers: { Origin: 'chrome-extension://abc', ...extensionHeaders('1234', 'martin') },
    }),
    env
  );
  assert.equal(response.status, 403);
});

workerTest('cross-origin GET allows a valid app password; other cross-origin calls stay blocked', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const authorized = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, {
      headers: { Origin: 'chrome-extension://abc', ...extensionHeaders() },
    }),
    env
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await readJson(authorized), { requests: [] });

  for (const headers of [
    { Origin: 'https://evil.example' },
    { Origin: 'https://evil.example', 'X-App-Username': 'alex', 'X-App-Password': 'wrong' },
  ]) {
    const rejected = await worker.fetch(
      new Request(`${WORKER_URL}/api/requests`, { headers }),
      env
    );
    assert.equal(rejected.status, 401);
    assert.deepEqual(await readJson(rejected), { error: 'Authentication required.' });
  }

  // PATCH has no extension-header shortcut: it still needs the login cookie.
  const patchResponse = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/some-id`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-App-Username': 'alex',
          'X-App-Password': '1234',
      },
      body: JSON.stringify({ status: 'Purchased' }),
    }),
    env
  );
  assert.equal(patchResponse.status, 403);
});

workerTest('the extension app-password header creates requests without a cookie', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const created = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://abc',
        'X-App-Username': 'alex',
          'X-App-Password': '1234',
      },
      body: JSON.stringify({
        title: 'Running shoes',
        url: 'https://example.com/shoes',
        note: 'Size 43',
        quantity: 2,
      }),
    }),
    env
  );
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('set-cookie'), null);

  const body = await readJson(created);
  assert.equal(body.request.title, 'Running shoes');
  assert.equal(body.request.status, 'New');
  assert.equal(body.request.price, null);
  assert.equal(env.DB.rows.length, 1);

  const listedForExtension = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, {
      headers: extensionHeaders(),
    }),
    env
  );
  assert.equal(listedForExtension.status, 200);
  const listedBody = await readJson(listedForExtension);
  assert.equal(listedBody.requests.length, 1);
  assert.equal(listedBody.requests[0].id, body.request.id);
  assert.equal(listedBody.requests[0].price, null);

  for (const headers of [
    { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' },
    { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc', 'X-App-Username': 'alex', 'X-App-Password': 'wrong' },
  ]) {
    const rejected = await worker.fetch(
      new Request(`${WORKER_URL}/api/requests`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Shoes', url: 'https://example.com/shoes' }),
      }),
      env
    );
    assert.equal(rejected.status, 401);
    assert.deepEqual(await readJson(rejected), { error: 'Authentication required.' });
  }

  assert.equal(env.DB.rows.length, 1);

  const invalid = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://abc',
        'X-App-Username': 'alex',
          'X-App-Password': '1234',
      },
      body: JSON.stringify({ title: '', url: 'javascript:alert(1)' }),
    }),
    env
  );
  assert.equal(invalid.status, 400);
  assert.ok((await readJson(invalid)).details.title);
});

workerTest('missing SESSION_SECRET refuses login without revealing config', async () => {
  const worker = (await loadWorker()).default;
  const response = await worker.fetch(login(), { DB: createFakeD1() });
  assert.equal(response.status, 503);
  assert.deepEqual(await readJson(response), { error: 'Login is not available.' });
});

workerTest('oversized and malformed login bodies are rejected', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const oversized = await worker.fetch(
    new Request(`${WORKER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(70 * 1024) }),
    }),
    env
  );
  assert.equal(oversized.status, 413);

  const malformed = await worker.fetch(
    new Request(`${WORKER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"password":',
    }),
    env
  );
  assert.equal(malformed.status, 400);
  assert.match((await readJson(malformed)).error, /JSON/i);
});

workerTest('authenticated create/list/update flow stores D1 rows and keeps API shapes', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const loginResponse = await worker.fetch(login(), env);
  const cookie = cookieFrom(loginResponse);
  const authHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

  const created = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: '  Running shoes ',
        url: 'https://example.com/shoes',
        note: 'Size 43',
        quantity: 2,
        price: 49.5,
      }),
    }),
    env
  );
  assert.equal(created.status, 201);
  const { request } = await readJson(created);
  assert.match(request.id, /^[0-9a-f-]{36}$/);
  assert.equal(request.title, 'Running shoes');
  assert.equal(request.quantity, 2);
  assert.equal(request.price, 49.5);
  assert.equal(request.status, 'New');
  assert.ok(Date.parse(request.submittedAt));

  const listed = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, { headers: { Cookie: cookie } }),
    env
  );
  assert.equal(listed.status, 200);
  const listedRequests = (await readJson(listed)).requests;
  assert.equal(listedRequests.length, 1);
  assert.equal(listedRequests[0].price, 49.5);

  const edited = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/${request.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'Running shoes (wide)',
        note: '',
        quantity: 3,
        price: 59.95,
      }),
    }),
    env
  );
  assert.equal(edited.status, 200);
  const editedRequest = (await readJson(edited)).request;
  assert.equal(editedRequest.title, 'Running shoes (wide)');
  assert.equal(editedRequest.note, '');
  assert.equal(editedRequest.quantity, 3);
  assert.equal(editedRequest.price, 59.95);
  assert.equal(editedRequest.url, 'https://example.com/shoes');
  assert.equal(editedRequest.status, 'New');

  const invalidEdit = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/${request.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ price: 1.234 }),
    }),
    env
  );
  assert.equal(invalidEdit.status, 400);
  assert.ok((await readJson(invalidEdit)).details.price);

  const emptied = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/${request.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ price: null }),
    }),
    env
  );
  assert.equal(emptied.status, 200);
  assert.equal((await readJson(emptied)).request.price, null);

  const updated = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/${request.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'Purchased' }),
    }),
    env
  );
  assert.equal(updated.status, 200);
  const updatedRequest = (await readJson(updated)).request;
  assert.equal(updatedRequest.status, 'Purchased');
  assert.equal(updatedRequest.title, 'Running shoes (wide)');
  assert.equal(updatedRequest.price, null);
  assert.ok(Date.parse(updatedRequest.updatedAt) >= Date.parse(updatedRequest.submittedAt));

  const invalid = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: '', url: 'javascript:alert(1)' }),
    }),
    env
  );
  assert.equal(invalid.status, 400);
  assert.ok((await readJson(invalid)).details.title);
});

workerTest('DELETE /api/requests/:id needs the session cookie, not the app password', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const anonymous = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/some-id`, { method: 'DELETE' }),
    env
  );
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await readJson(anonymous), { error: 'Authentication required.' });

  // Same-origin DELETE with only the extension header must stay unauthenticated.
  const headerOnly = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/some-id`, {
      method: 'DELETE',
      headers: extensionHeaders(),
    }),
    env
  );
  assert.equal(headerOnly.status, 401);
  assert.deepEqual(await readJson(headerOnly), { error: 'Authentication required.' });

  // Cross-origin DELETE is rejected like PATCH, even with the header.
  for (const headers of [
    { Origin: 'https://evil.example' },
    { Origin: 'https://evil.example', ...extensionHeaders() },
  ]) {
    const crossOrigin = await worker.fetch(
      new Request(`${WORKER_URL}/api/requests/some-id`, { method: 'DELETE', headers }),
      env
    );
    assert.equal(crossOrigin.status, 403);
    assert.match((await readJson(crossOrigin)).error, /Cross-origin/);
  }

  // The normal same-origin, cookie-authenticated path deletes the row.
  const loginResponse = await worker.fetch(login(), env);
  const cookie = cookieFrom(loginResponse);
  const authHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

  const created = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'Bin me', url: 'https://example.com/bin' }),
    }),
    env
  );
  assert.equal(created.status, 201);
  const { request } = await readJson(created);
  assert.equal(env.DB.rows.length, 1);

  const deleted = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests/${request.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }),
    env
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(await readJson(deleted), { deleted: true, id: request.id });
  assert.equal(env.DB.rows.length, 0);

  const listed = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, { headers: { Cookie: cookie } }),
    env
  );
  assert.deepEqual(await readJson(listed), { requests: [] });

  for (const pathname of [`/api/requests/${request.id}`, '/api/requests/does-not-exist']) {
    const missing = await worker.fetch(
      new Request(`${WORKER_URL}${pathname}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      }),
      env
    );
    assert.equal(missing.status, 404, `${pathname} should be 404`);
    assert.deepEqual(await readJson(missing), { error: 'Request not found.' });
  }
});

workerTest('the item route keeps a JSON 405 for non-PATCH/DELETE methods', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();
  const loginResponse = await worker.fetch(login(), env);
  const cookie = cookieFrom(loginResponse);

  for (const method of ['PUT', 'GET', 'POST']) {
    const response = await worker.fetch(
      new Request(`${WORKER_URL}/api/requests/some-id`, { method, headers: { Cookie: cookie } }),
      env
    );
    assert.equal(response.status, 405, `${method} should be 405`);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await readJson(response), {
      error: 'Method not allowed. Use PATCH or DELETE.',
    });
  }
});

workerTest('a create with an app password notifies ntfy once and still returns 201', async () => {
  const worker = (await loadWorker()).default;
  const topic = 'bifm-test-topic-app-password';
  const env = envWithDb({ NTFY_TOPIC: topic });
  const ntfy = createFakeNtfyFetch();

  const response = await withFakeFetch(ntfy, () =>
    worker.fetch(
      new Request(`${WORKER_URL}/api/requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'chrome-extension://abc',
          'X-App-Username': 'alex',
          'X-App-Password': '1234',
        },
        body: JSON.stringify({
          title: 'Running shoes',
          url: 'https://example.com/shoes',
          quantity: 2,
          price: 12.99,
        }),
      }),
      env
    )
  );

  assert.equal(response.status, 201);
  assert.equal((await readJson(response)).request.title, 'Running shoes');

  assert.equal(ntfy.calls.length, 1);
  const [call] = ntfy.calls;
  assert.equal(call.url, `https://ntfy.sh/${topic}`);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Title, 'New shopping request');
  assert.equal(call.options.headers.Tags, 'shopping_cart');
  assert.equal(call.options.headers.Priority, 'default');
  assert.equal(call.options.headers.Click, WORKER_URL);
  assert.equal(
    call.options.body,
    'Running shoes\nQty 2 · 12.99\nhttps://example.com/shoes'
  );
});

workerTest('a create also notifies Discord when the webhook is configured', async () => {
  const worker = (await loadWorker()).default;
  const webhook = 'https://discord.com/api/webhooks/123456789/abcdef-token';
  const env = envWithDb({ DISCORD_WEBHOOK_URL: webhook });
  const calls = [];

  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 204 };
  };

  const response = await withFakeFetch(fetchImpl, () =>
    worker.fetch(
      new Request(`${WORKER_URL}/api/requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'chrome-extension://abc',
          'X-App-Username': 'alex',
          'X-App-Password': '1234',
        },
        body: JSON.stringify({
          title: 'Running shoes',
          url: 'https://example.com/shoes',
          quantity: 2,
          price: 12.99,
        }),
      }),
      env
    )
  );

  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, webhook);

  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, 'Running shoes');
  assert.equal(payload.embeds[0].url, 'https://example.com/shoes');
});

workerTest('a Discord failure never changes the 201 response', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb({
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/token',
  });

  const response = await withFakeFetch(
    async () => ({ ok: false, status: 429 }),
    () =>
      worker.fetch(
        new Request(`${WORKER_URL}/api/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'chrome-extension://abc',
            'X-App-Username': 'alex',
          'X-App-Password': '1234',
          },
          body: JSON.stringify({ title: 'Shoes', url: 'https://example.com/shoes' }),
        }),
        env
      )
  );

  assert.equal(response.status, 201);
});

workerTest('a cookie-authenticated create defers the notification to ctx.waitUntil', async () => {
  const worker = (await loadWorker()).default;
  const topic = 'bifm-test-topic-cookie';
  const env = envWithDb({ NTFY_TOPIC: topic });
  const ntfy = createFakeNtfyFetch();
  const pending = [];
  const ctx = {
    waitUntil(promise) {
      pending.push(promise);
    },
  };

  const cookie = cookieFrom(await worker.fetch(login(), env));

  const response = await withFakeFetch(ntfy, () =>
    worker.fetch(
      new Request(`${WORKER_URL}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Bin bags', url: 'https://example.com/bags' }),
      }),
      env,
      ctx
    )
  );

  assert.equal(response.status, 201);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(ntfy.calls.length, 1);
  assert.equal(ntfy.calls[0].url, `https://ntfy.sh/${topic}`);
  assert.equal(ntfy.calls[0].options.headers.Click, WORKER_URL);
});

workerTest('creating without NTFY_TOPIC sends nothing and still returns 201', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();
  const ntfy = createFakeNtfyFetch();

  const response = await withFakeFetch(ntfy, () =>
    worker.fetch(
      new Request(`${WORKER_URL}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extensionHeaders() },
        body: JSON.stringify({ title: 'No topic', url: 'https://example.com/none' }),
      }),
      env
    )
  );

  assert.equal(response.status, 201);
  assert.equal(ntfy.calls.length, 0);
  assert.equal(env.DB.rows.length, 1);
});

workerTest('an ntfy 500 or network error never changes the 201 response', async () => {
  const worker = (await loadWorker()).default;
  const topic = 'bifm-test-topic-failures';

  for (const scenario of ['status', 'throw']) {
    const env = envWithDb({ NTFY_TOPIC: topic });
    const ntfy =
      scenario === 'status'
        ? createFakeNtfyFetch({ ok: false, status: 500 })
        : async () => {
            throw new TypeError('ntfy unreachable');
          };

    const { value: response, messages } = await quietly(() =>
      withFakeFetch(ntfy, () =>
        worker.fetch(
          new Request(`${WORKER_URL}/api/requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...extensionHeaders() },
            body: JSON.stringify({ title: 'Fail softly', url: 'https://example.com/soft' }),
          }),
          env
        )
      )
    );

    assert.equal(response.status, 201, `${scenario} must still create the request`);
    assert.equal((await readJson(response)).request.title, 'Fail softly');
    assert.equal(env.DB.rows.length, 1);
    assert.equal(messages.length, 1);
    assert.ok(!messages[0].includes(topic), 'logs must not contain the topic');
  }
});

workerTest('a non-https NTFY_SERVER skips the notification and still returns 201', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb({
    NTFY_TOPIC: 'bifm-test-topic-insecure',
    NTFY_SERVER: 'http://ntfy.sh',
  });
  const ntfy = createFakeNtfyFetch();

  const { value: response } = await quietly(() =>
    withFakeFetch(ntfy, () =>
      worker.fetch(
        new Request(`${WORKER_URL}/api/requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extensionHeaders() },
          body: JSON.stringify({ title: 'Insecure server', url: 'https://example.com/http' }),
        }),
        env
      )
    )
  );

  assert.equal(response.status, 201);
  assert.equal(ntfy.calls.length, 0);
});

workerTest('PATCH and DELETE never notify ntfy', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb({ NTFY_TOPIC: 'bifm-test-topic-updates' });
  const ntfy = createFakeNtfyFetch();

  const cookie = cookieFrom(await worker.fetch(login(), env));
  const authHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

  const created = await withFakeFetch(ntfy, () =>
    worker.fetch(
      new Request(`${WORKER_URL}/api/requests`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ title: 'Edit me', url: 'https://example.com/edit' }),
      }),
      env
    )
  );
  assert.equal(created.status, 201);
  assert.equal(ntfy.calls.length, 1, 'the create itself notifies once');
  const { request } = await readJson(created);

  ntfy.calls.length = 0;

  await withFakeFetch(ntfy, () =>
    worker.fetch(
      new Request(`${WORKER_URL}/api/requests/${request.id}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ status: 'Purchased' }),
      }),
      env
    )
  );

  const deleted = await withFakeFetch(ntfy, () =>
    worker.fetch(
      new Request(`${WORKER_URL}/api/requests/${request.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      }),
      env
    )
  );

  assert.equal(deleted.status, 200);
  assert.equal(ntfy.calls.length, 0);
});
