'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const loadNotify = () => import('../src/notify.js');

const ORIGIN = 'https://buy-this-for-me.example.workers.dev';
const TOPIC = 'bifm-test-topic-8f3a';

function sampleRequest(overrides = {}) {
  return {
    title: 'Running shoes',
    url: 'https://example.com/shoes',
    note: '',
    quantity: 2,
    price: 12.99,
    ...overrides,
  };
}

function fakeFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    return response;
  };
  impl.calls = calls;
  return impl;
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

test('builds the title, ntfy headers and a short body with quantity, price and link', async () => {
  const { buildNtfyMessage } = await loadNotify();

  const message = buildNtfyMessage(sampleRequest(), ORIGIN);
  assert.equal(message.title, 'New shopping request');
  assert.equal(message.tags, 'shopping_cart');
  assert.equal(message.priority, 'default');
  assert.equal(message.click, ORIGIN);
  assert.equal(
    message.body,
    'Running shoes\nQty 2 · 12.99\nhttps://example.com/shoes'
  );
});

test('omits the price part when the request has no price', async () => {
  const { buildNtfyMessage } = await loadNotify();

  const message = buildNtfyMessage(sampleRequest({ price: null }), ORIGIN);
  assert.equal(message.body, 'Running shoes\nQty 2\nhttps://example.com/shoes');
  assert.doesNotMatch(message.body, /·/);

  const noQuantity = buildNtfyMessage(sampleRequest({ quantity: undefined }), ORIGIN);
  assert.equal(noQuantity.body, 'Running shoes\nPrice 12.99\nhttps://example.com/shoes');
});

test('keeps the body at 300 characters, dropping the link before the title', async () => {
  const { buildNtfyMessage } = await loadNotify();

  const longTitle = 'T'.repeat(200);
  const longUrl = `https://example.com/${'a'.repeat(200)}`;
  const message = buildNtfyMessage(
    sampleRequest({ title: longTitle, url: longUrl, note: 'n'.repeat(100) }),
    ORIGIN
  );

  assert.ok(message.body.length <= 300, `body was ${message.body.length} characters`);
  assert.equal(message.body, `${longTitle}\nQty 2 · 12.99`);
  assert.ok(!message.body.includes(longUrl));

  const hugeTitle = buildNtfyMessage(sampleRequest({ title: 'A'.repeat(500) }), ORIGIN);
  assert.equal(hugeTitle.body.length, 300);
  const [clippedLine, details] = hugeTitle.body.split('\n');
  assert.match(clippedLine, /…$/);
  assert.equal(details, 'Qty 2 · 12.99');
});

test('includes a short note only when the whole body still fits', async () => {
  const { buildNtfyMessage } = await loadNotify();

  const short = buildNtfyMessage(sampleRequest({ note: 'Size 43' }), ORIGIN);
  assert.equal(
    short.body,
    'Running shoes\nQty 2 · 12.99\nhttps://example.com/shoes\nSize 43'
  );

  const long = buildNtfyMessage(sampleRequest({ note: 'n'.repeat(320) }), ORIGIN);
  assert.ok(long.body.length <= 300);
  assert.ok(!long.body.includes('n'.repeat(20)));
});

test('sends exactly one POST to https://ntfy.sh/<topic> with the ntfy headers', async () => {
  const { buildNtfyMessage, sendNtfyNotification } = await loadNotify();

  const fetchImpl = fakeFetch();
  const message = buildNtfyMessage(sampleRequest(), ORIGIN);
  const result = await sendNtfyNotification({ NTFY_TOPIC: TOPIC }, message, fetchImpl);

  assert.deepEqual(result, { sent: true });
  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, `https://ntfy.sh/${TOPIC}`);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Title, 'New shopping request');
  assert.equal(call.options.headers.Tags, 'shopping_cart');
  assert.equal(call.options.headers.Priority, 'default');
  assert.equal(call.options.headers.Click, ORIGIN);
  assert.equal(call.options.body, message.body);
});

test('uses an https NTFY_SERVER override and skips insecure or missing config', async () => {
  const { buildNtfyMessage, sendNtfyNotification } = await loadNotify();
  const message = buildNtfyMessage(sampleRequest(), ORIGIN);

  const custom = fakeFetch();
  await sendNtfyNotification(
    { NTFY_TOPIC: TOPIC, NTFY_SERVER: 'https://ntfy.example.com/' },
    message,
    custom
  );
  assert.equal(custom.calls.length, 1);
  assert.equal(custom.calls[0].url, `https://ntfy.example.com/${TOPIC}`);

  for (const env of [
    { NTFY_TOPIC: TOPIC, NTFY_SERVER: 'http://ntfy.sh' },
    { NTFY_TOPIC: TOPIC, NTFY_SERVER: 'ftp://ntfy.sh' },
    { NTFY_TOPIC: TOPIC, NTFY_SERVER: 'not a url' },
    { NTFY_TOPIC: '' },
    {},
  ]) {
    const skipped = fakeFetch();
    const result = await quietly(() => sendNtfyNotification(env, message, skipped));
    assert.equal(result.value.sent, false);
    assert.equal(skipped.calls.length, 0, `${JSON.stringify(env)} should not send`);
  }
});

test('reports a rejected response and a network error without leaking the topic', async () => {
  const { buildNtfyMessage, sendNtfyNotification } = await loadNotify();
  const message = buildNtfyMessage(sampleRequest(), ORIGIN);

  const rejected = await quietly(() =>
    sendNtfyNotification(
      { NTFY_TOPIC: TOPIC },
      message,
      fakeFetch({ ok: false, status: 500 })
    )
  );
  assert.equal(rejected.value.sent, false);
  assert.equal(rejected.messages.length, 1);
  assert.match(rejected.messages[0], /500/);
  assert.ok(!rejected.messages[0].includes(TOPIC));

  const thrown = await quietly(() =>
    sendNtfyNotification({ NTFY_TOPIC: TOPIC }, message, async () => {
      throw new TypeError('network down');
    })
  );
  assert.equal(thrown.value.sent, false);
  assert.equal(thrown.messages.length, 1);
  assert.ok(!thrown.messages[0].includes(TOPIC));
});
