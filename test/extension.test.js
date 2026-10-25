'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REMOTE_URL = 'https://buy-this-for-me.example.workers.dev';
const LOCAL_URL = 'http://127.0.0.1:3000';

function createElement() {
  return {
    hidden: false,
    textContent: '',
    value: '',
    href: '',
    dataset: {},
    children: [],
    replaceChildren(...children) {
      this.children = children;
    },
    append(...children) {
      this.children.push(...children);
    },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
    focus() {},
    select() {},
    reset() {},
  };
}

/**
 * Run the real extension scripts in a vm context with just enough browser
 * stubs to exercise the popup's submit paths.
 */
function loadPopup({ backendUrl = REMOTE_URL, fetchImpl } = {}) {
  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
    createElement() {
      return createElement();
    },
  };

  const createdTabs = [];
  const chrome = {
    storage: {
      local: {
        async get() {
          return { backendUrl };
        },
        async set() {},
      },
    },
    tabs: {
      async create(options) {
        createdTabs.push(options);
        return { id: createdTabs.length, ...options };
      },
      async query() {
        return [{ title: 'Example product', url: 'https://example.com/product' }];
      },
    },
    runtime: {
      openOptionsPage() {},
    },
  };

  const context = vm.createContext({
    chrome,
    document,
    URL,
    console,
    fetch: fetchImpl || (async () => {
      throw new Error('Unexpected fetch in extension test.');
    }),
  });

  for (const file of ['settings.js', 'popup.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', file), 'utf8');
    const suffix =
      file === 'popup.js'
        ? '\n;globalThis.__popupTest = { openRemoteDraft, sendToLocal, backendReady };'
        : '';
    vm.runInContext(source + suffix, context, { filename: file });
  }

  return { ...context.__popupTest, elements, createdTabs };
}

test('remote submissions open the dashboard in a foreground tab', async () => {
  const { openRemoteDraft, backendReady, elements, createdTabs } = loadPopup();
  await backendReady;

  const payload = {
    title: 'Running shoes',
    url: 'https://example.com/shoes',
    note: 'Size 43',
    quantity: 2,
  };
  assert.equal(await openRemoteDraft(payload), true);

  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].active, true);

  const created = new URL(createdTabs[0].url);
  assert.equal(created.origin, REMOTE_URL);
  const draft = JSON.parse(decodeURIComponent(created.hash.slice('#draft='.length)));
  assert.deepEqual(draft, payload);

  const status = elements.get('status');
  assert.equal(status.hidden, false);
  assert.match(status.children[0].textContent, /new tab/i);
  assert.doesNotMatch(status.children[0].textContent, /background/i);
});

test('local submissions still post directly and open no tab', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 201,
      async json() {
        return { request: { title: 'Running shoes' } };
      },
    };
  };

  const { sendToLocal, backendReady, createdTabs } = loadPopup({
    backendUrl: LOCAL_URL,
    fetchImpl,
  });
  await backendReady;

  const payload = {
    title: 'Running shoes',
    url: 'https://example.com/shoes',
    note: '',
    quantity: 1,
  };
  assert.equal(await sendToLocal(payload), true);

  assert.equal(createdTabs.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${LOCAL_URL}/api/requests`);
  assert.equal(calls[0].options.method, 'POST');
});
