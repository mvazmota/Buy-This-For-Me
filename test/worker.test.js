'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const WORKER_URL = 'https://buy-this-for-me.example.workers.dev';
const PASSWORD = 'correct horse battery staple';

// Node 18 does not expose global WebCrypto by default; the Worker tests need it.
const hasWebCrypto = Boolean(globalThis.crypto && globalThis.crypto.subtle);
const workerTest = hasWebCrypto ? test : test.skip;

const loadWorker = () => import('../src/worker.js');
const loadSession = () => import('../src/session.js');

async function readJson(response) {
  return response.json();
}

function login(password = PASSWORD) {
  return new Request(`${WORKER_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

/** Tiny D1 stand-in that understands the Worker's four SQL statements. */
function createFakeD1() {
  const rows = [];

  return {
    rows,
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
              status: args[5],
              submitted_at: args[6],
              updated_at: args[7],
            });
            return { meta: { changes: 1 } };
          }
          if (/^UPDATE requests/i.test(sql)) {
            const row = rows.find((entry) => entry.id === args[2]);
            if (!row) return { meta: { changes: 0 } };
            row.status = args[0];
            row.updated_at = args[1];
            return { meta: { changes: 1 } };
          }
          throw new Error(`Unexpected run() query: ${sql}`);
        },
      };
    },
  };
}

function envWithDb() {
  return { APP_PASSWORD: PASSWORD, DB: createFakeD1(), ASSETS: { fetch: async () => new Response('asset') } };
}

workerTest('session tokens are signed, expiring and tamper-evident', async () => {
  const { createSessionToken, verifySessionToken, SESSION_TTL_SECONDS } = await loadSession();

  const token = await createSessionToken(PASSWORD);
  assert.equal(await verifySessionToken(token, PASSWORD), true);
  assert.equal(await verifySessionToken(token, 'wrong password'), false);
  assert.equal(await verifySessionToken(`${token}x`, PASSWORD), false);
  assert.equal(await verifySessionToken('not-a-token', PASSWORD), false);
  assert.equal(await verifySessionToken(token, ''), false);

  const expired = await createSessionToken(
    PASSWORD,
    Date.now() - (SESSION_TTL_SECONDS + 60) * 1000
  );
  assert.equal(await verifySessionToken(expired, PASSWORD), false);
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
  assert.deepEqual(await readJson(response), { error: 'Invalid password.' });
  assert.equal(response.headers.get('set-cookie'), null);
});

workerTest('login sets an HttpOnly, Secure, SameSite=Lax session cookie', async () => {
  const worker = (await loadWorker()).default;
  const env = envWithDb();

  const response = await worker.fetch(login(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { authenticated: true, authRequired: true });

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
  assert.deepEqual(await readJson(session), { authenticated: true, authRequired: true });
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
    body: JSON.stringify({ password: PASSWORD }),
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 403);
  assert.match((await readJson(response)).error, /Cross-origin/);
});

workerTest('missing APP_PASSWORD refuses login without revealing config', async () => {
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
      }),
    }),
    env
  );
  assert.equal(created.status, 201);
  const { request } = await readJson(created);
  assert.match(request.id, /^[0-9a-f-]{36}$/);
  assert.equal(request.title, 'Running shoes');
  assert.equal(request.quantity, 2);
  assert.equal(request.status, 'New');
  assert.ok(Date.parse(request.submittedAt));

  const listed = await worker.fetch(
    new Request(`${WORKER_URL}/api/requests`, { headers: { Cookie: cookie } }),
    env
  );
  assert.equal(listed.status, 200);
  assert.equal((await readJson(listed)).requests.length, 1);

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
