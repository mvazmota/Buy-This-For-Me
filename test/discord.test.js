'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const loadNotify = () => import('../src/notify.js');

const ORIGIN = 'https://buy-this-for-me.example.workers.dev';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/abcdef-token';

function sampleRequest(overrides = {}) {
  return {
    title: 'Running shoes',
    url: 'https://example.com/shoes',
    note: '',
    quantity: 2,
    price: 12.99,
    submittedAt: '2026-10-28T10:00:00.000Z',
    ...overrides,
  };
}

function fakeFetch(response = { ok: true, status: 204 }) {
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

test('builds a Discord embed with title, product link, quantity, euro price and dashboard', async () => {
  const { buildDiscordMessage } = await loadNotify();

  const payload = buildDiscordMessage(sampleRequest(), ORIGIN);
  assert.equal(payload.embeds.length, 1);

  const [embed] = payload.embeds;
  assert.equal(embed.title, 'Running shoes');
  assert.equal(embed.url, 'https://example.com/shoes');
  assert.equal(embed.color, 0x2563eb);
  assert.equal(embed.timestamp, '2026-10-28T10:00:00.000Z');
  assert.equal(embed.description, undefined);

  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Quantity, '2');
  assert.equal(fields.Price, '12,99 €');
  assert.equal(fields.Dashboard, ORIGIN);
});

test('Discord embed omits the price field when there is no price', async () => {
  const { buildDiscordMessage } = await loadNotify();

  const [embed] = buildDiscordMessage(sampleRequest({ price: null }), ORIGIN).embeds;
  const names = embed.fields.map((field) => field.name);
  assert.ok(!names.includes('Price'));
  assert.ok(names.includes('Quantity'));
});

test('Discord embed carries a trimmed note as description', async () => {
  const { buildDiscordMessage } = await loadNotify();

  const [short] = buildDiscordMessage(sampleRequest({ note: 'Size 43, blue' }), ORIGIN).embeds;
  assert.equal(short.description, 'Size 43, blue');

  const [long] = buildDiscordMessage(sampleRequest({ note: 'n'.repeat(2000) }), ORIGIN).embeds;
  assert.ok(long.description.length <= 300);
  assert.match(long.description, /…$/);
});

test('Discord embed caps a very long title at 256 characters', async () => {
  const { buildDiscordMessage } = await loadNotify();

  const [embed] = buildDiscordMessage(sampleRequest({ title: 'A'.repeat(500) }), ORIGIN).embeds;
  assert.ok(embed.title.length <= 256);
  assert.match(embed.title, /…$/);
});

test('posts the Discord payload as JSON with a User-Agent', async () => {
  const { buildDiscordMessage, sendDiscordNotification } = await loadNotify();

  const fetchImpl = fakeFetch();
  const message = buildDiscordMessage(sampleRequest(), ORIGIN);
  const result = await sendDiscordNotification({ DISCORD_WEBHOOK_URL: WEBHOOK }, message, fetchImpl);

  assert.deepEqual(result, { sent: true });
  assert.equal(fetchImpl.calls.length, 1);

  const [call] = fetchImpl.calls;
  assert.equal(call.url, WEBHOOK);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.match(call.options.headers['User-Agent'], /BIFM/);
  assert.deepEqual(JSON.parse(call.options.body), message);
});

test('rejects non-Discord or insecure webhook URLs without leaking them', async () => {
  const { buildDiscordMessage, sendDiscordNotification } = await loadNotify();
  const message = buildDiscordMessage(sampleRequest(), ORIGIN);

  const bad = [
    'http://discord.com/api/webhooks/1/token',
    'https://evil.example/api/webhooks/1/token',
    'https://discord.com/not-a-webhook/1/token',
    'not a url',
  ];

  for (const url of bad) {
    const fetchImpl = fakeFetch();
    const { value, messages } = await quietly(() =>
      sendDiscordNotification({ DISCORD_WEBHOOK_URL: url }, message, fetchImpl)
    );
    assert.equal(value.sent, false);
    assert.equal(value.reason, 'invalid-webhook');
    assert.equal(fetchImpl.calls.length, 0, `${url} should not send`);

    for (const line of messages) {
      assert.ok(!line.includes('token'), `log leaked the webhook: ${line}`);
    }
  }
});

test('skips Discord when no webhook is configured', async () => {
  const { buildDiscordMessage, sendDiscordNotification } = await loadNotify();
  const message = buildDiscordMessage(sampleRequest(), ORIGIN);

  for (const env of [{}, { DISCORD_WEBHOOK_URL: '' }, { DISCORD_WEBHOOK_URL: '   ' }]) {
    const fetchImpl = fakeFetch();
    const result = await sendDiscordNotification(env, message, fetchImpl);
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'no-webhook');
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('logs Discord 429 and failures without the webhook URL', async () => {
  const { buildDiscordMessage, sendDiscordNotification } = await loadNotify();
  const message = buildDiscordMessage(sampleRequest(), ORIGIN);

  const limited = await quietly(() =>
    sendDiscordNotification(
      { DISCORD_WEBHOOK_URL: WEBHOOK },
      message,
      fakeFetch({ ok: false, status: 429 })
    )
  );
  assert.equal(limited.value.sent, false);
  assert.equal(limited.messages.length, 1);
  assert.match(limited.messages[0], /status 429/);
  assert.ok(!limited.messages[0].includes(WEBHOOK));

  const thrown = await quietly(() =>
    sendDiscordNotification({ DISCORD_WEBHOOK_URL: WEBHOOK }, message, async () => {
      throw new TypeError('boom');
    })
  );
  assert.equal(thrown.value.sent, false);
  assert.equal(thrown.value.reason, 'network-error');
  assert.ok(!thrown.messages[0].includes(WEBHOOK));
});

test('dispatches to every configured channel exactly once', async () => {
  const { notifyNewRequest } = await loadNotify();

  const both = fakeFetch({ ok: true, status: 200 });
  const result = await notifyNewRequest(
    { NTFY_TOPIC: 'topic-abc', DISCORD_WEBHOOK_URL: WEBHOOK },
    sampleRequest(),
    ORIGIN,
    { fetchImpl: both }
  );

  assert.equal(result.sent, true);
  assert.deepEqual(result.results.ntfy, { sent: true });
  assert.deepEqual(result.results.discord, { sent: true });
  assert.equal(both.calls.length, 2);
  assert.ok(both.calls.some((call) => call.url.includes('ntfy.sh')));
  assert.ok(both.calls.some((call) => call.url === WEBHOOK));

  const discordOnly = fakeFetch({ ok: true, status: 204 });
  await notifyNewRequest(
    { DISCORD_WEBHOOK_URL: WEBHOOK },
    sampleRequest(),
    ORIGIN,
    { fetchImpl: discordOnly }
  );
  assert.equal(discordOnly.calls.length, 1);
  assert.equal(discordOnly.calls[0].url, WEBHOOK);

  const none = fakeFetch();
  const empty = await notifyNewRequest({}, sampleRequest(), ORIGIN, { fetchImpl: none });
  assert.equal(empty.sent, false);
  assert.equal(empty.reason, 'no-channel');
  assert.equal(none.calls.length, 0);
});

test('one failing channel does not stop the other', async () => {
  const { notifyNewRequest } = await loadNotify();

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('ntfy.sh')) {
      throw new TypeError('ntfy down');
    }
    return { ok: true, status: 204 };
  };

  const { value } = await quietly(() =>
    notifyNewRequest(
      { NTFY_TOPIC: 'topic-abc', DISCORD_WEBHOOK_URL: WEBHOOK },
      sampleRequest(),
      ORIGIN,
      { fetchImpl }
    )
  );

  assert.equal(calls.length, 2);
  assert.equal(value.results.ntfy.sent, false);
  assert.equal(value.results.discord.sent, true);
});
