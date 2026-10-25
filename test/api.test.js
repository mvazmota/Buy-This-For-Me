'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');

const { createApp } = require('../lib/app');
const { validateNewRequest } = require('../lib/validate');

function makeTempDataFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifm-test-'));
  return { dir, dataFile: path.join(dir, 'data', 'requests.json') };
}

async function startApp(dataFile) {
  const app = createApp({ dataFile });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return { app, base: `http://127.0.0.1:${port}` };
}

async function stopApp(app) {
  await new Promise((resolve) => app.server.close(resolve));
}

async function withServer(fn) {
  const { dir, dataFile } = makeTempDataFile();
  const { app, base } = await startApp(dataFile);
  try {
    await fn({ base, dataFile });
  } finally {
    await stopApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function postJson(base, body, pathname = '/api/requests') {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validPayload = {
  title: 'Running shoes',
  url: 'https://example.com/shoes',
  note: 'Size 43, blue',
  quantity: 2,
};

test('GET /api/health responds ok', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('GET /api/requests starts empty', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/requests`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { requests: [] });
  });
});

test('POST /api/requests creates a request with defaults', async () => {
  await withServer(async ({ base }) => {
    const res = await postJson(base, { title: '  Milk  ', url: 'https://example.com/milk' });
    assert.equal(res.status, 201);
    const { request } = await res.json();
    assert.match(request.id, /^[0-9a-f-]{36}$/);
    assert.equal(request.title, 'Milk');
    assert.equal(request.note, '');
    assert.equal(request.quantity, 1);
    assert.equal(request.status, 'New');
    assert.ok(!Number.isNaN(Date.parse(request.submittedAt)));
    assert.equal(request.updatedAt, request.submittedAt);
  });
});

test('requests are listed newest-first and persist to disk', async () => {
  const { dir, dataFile } = makeTempDataFile();
  let first;
  try {
    first = await startApp(dataFile);
    const firstRes = await postJson(first.base, { title: 'First', url: 'https://example.com/1' });
    assert.equal(firstRes.status, 201);
    const secondRes = await postJson(first.base, { title: 'Second', url: 'https://example.com/2' });
    assert.equal(secondRes.status, 201);

    const listed = await (await fetch(`${first.base}/api/requests`)).json();
    assert.deepEqual(
      listed.requests.map((request) => request.title),
      ['Second', 'First']
    );
    await stopApp(first.app);

    const second = await startApp(dataFile);
    try {
      const reloaded = await (await fetch(`${second.base}/api/requests`)).json();
      assert.equal(reloaded.requests.length, 2);
      assert.equal(reloaded.requests[0].title, 'Second');
    } finally {
      await stopApp(second.app);
    }
  } finally {
    if (first) await stopApp(first.app).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST rejects invalid fields with per-field details', async () => {
  await withServer(async ({ base }) => {
    const res = await postJson(base, {
      title: '   ',
      url: 'javascript:alert(1)',
      note: 'x'.repeat(1001),
      quantity: 0,
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(typeof data.error, 'string');
    assert.ok(data.details.title);
    assert.ok(data.details.url);
    assert.ok(data.details.note);
    assert.ok(data.details.quantity);

    const nonInteger = await postJson(base, { ...validPayload, quantity: 1.5 });
    assert.equal(nonInteger.status, 400);
    assert.ok((await nonInteger.json()).details.quantity);

    const stringQuantity = await postJson(base, { ...validPayload, quantity: '3' });
    assert.equal(stringQuantity.status, 400);

    const missingBodyFields = await postJson(base, {});
    assert.equal(missingBodyFields.status, 400);
    assert.ok((await missingBodyFields.json()).details.title);
  });
});

test('validation accepts http and https but rejects other protocols', () => {
  assert.equal(validateNewRequest({ title: 'A', url: 'http://example.com' }).ok, true);
  assert.equal(validateNewRequest({ title: 'A', url: 'https://example.com' }).ok, true);
  for (const url of ['ftp://example.com', 'file:///C:/secret.txt', 'example.com', 'javascript:alert(1)']) {
    const result = validateNewRequest({ title: 'A', url });
    assert.equal(result.ok, false, `expected ${url} to be rejected`);
    assert.ok(result.errors.url);
  }
});

test('PATCH /api/requests/:id updates status', async () => {
  await withServer(async ({ base }) => {
    const created = await (await postJson(base, validPayload)).json();
    const id = created.request.id;

    const res = await fetch(`${base}/api/requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Purchased' }),
    });
    assert.equal(res.status, 200);
    const { request } = await res.json();
    assert.equal(request.status, 'Purchased');
    assert.equal(request.title, validPayload.title);
    assert.ok(Date.parse(request.updatedAt) >= Date.parse(request.submittedAt));

    const listed = await (await fetch(`${base}/api/requests`)).json();
    assert.equal(listed.requests[0].status, 'Purchased');
  });
});

test('PATCH rejects invalid status and unknown id', async () => {
  await withServer(async ({ base }) => {
    const created = await (await postJson(base, validPayload)).json();
    const id = created.request.id;

    const badStatus = await fetch(`${base}/api/requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Bought' }),
    });
    assert.equal(badStatus.status, 400);
    assert.ok((await badStatus.json()).details.status);

    const unknown = await fetch(`${base}/api/requests/does-not-exist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Done' }),
    });
    assert.equal(unknown.status, 404);
  });
});

test('malformed JSON and oversized bodies are rejected', async () => {
  await withServer(async ({ base }) => {
    const malformed = await postJson(base, '{"title": ');
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /JSON/i);

    const empty = await postJson(base, '');
    assert.equal(empty.status, 400);

    const oversized = await postJson(base, { title: 'x'.repeat(70 * 1024), url: 'https://example.com' });
    assert.equal(oversized.status, 413);
  });
});

test('unknown API routes and wrong methods return JSON errors', async () => {
  await withServer(async ({ base }) => {
    const notFound = await fetch(`${base}/api/nope`);
    assert.equal(notFound.status, 404);
    assert.match((await notFound.json()).error, /not found/i);

    const wrongMethod = await fetch(`${base}/api/requests`, { method: 'DELETE' });
    assert.equal(wrongMethod.status, 405);

    const wrongPatchTarget = await fetch(`${base}/api/requests`, { method: 'PUT' });
    assert.equal(wrongPatchTarget.status, 405);
  });
});

test('local session endpoints keep the dashboard password-free', async () => {
  await withServer(async ({ base }) => {
    const session = await fetch(`${base}/api/session`);
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { authenticated: true, authRequired: false });

    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'anything' }),
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { authenticated: true, authRequired: false });

    const logout = await fetch(`${base}/api/logout`, { method: 'POST' });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { authenticated: true, authRequired: false });
  });
});

test('session endpoints reject wrong methods', async () => {
  await withServer(async ({ base }) => {
    for (const pathname of ['/api/session', '/api/login', '/api/logout']) {
      const response = await fetch(`${base}${pathname}`, { method: 'DELETE' });
      assert.equal(response.status, 405, `${pathname} should reject DELETE`);
    }
  });
});

test('dashboard is served and path traversal is blocked', async () => {
  await withServer(async ({ base }) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /Shopping requests/);

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const traversal = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: new URL(base).port, path: '/%2e%2e/server.js' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(traversal, 404);
  });
});
