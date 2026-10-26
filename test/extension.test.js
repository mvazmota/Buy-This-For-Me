'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ICON_SIZES = [16, 32, 48, 128];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const REMOTE_URL = 'https://buy-this-for-me.example.workers.dev';
const WORKER_URL = 'https://buy-this-for-me.m-vaz-mota.workers.dev';
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
          // Treat null as "no stored value"; the parameter default is a stored URL.
          return backendUrl === null ? {} : { backendUrl };
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
        ? '\n;globalThis.__popupTest = { openRemoteDraft, sendToLocal, backendReady, getBackendUrl };'
        : '';
    vm.runInContext(source + suffix, context, { filename: file });
  }

  return { ...context.__popupTest, elements, createdTabs };
}

test('no stored backend URL falls back to the deployed Worker URL', async () => {
  const { getBackendUrl } = loadPopup({ backendUrl: null });
  assert.equal(await getBackendUrl(), WORKER_URL);
});

test('an explicitly saved backend URL is not replaced by the default', async () => {
  const { getBackendUrl } = loadPopup({ backendUrl: LOCAL_URL });
  assert.equal(await getBackendUrl(), LOCAL_URL);
});

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

test('manifest declares PNG icons and toolbar icons that exist', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'),
  );

  assert.ok(manifest.icons, 'manifest.icons is missing');
  assert.ok(manifest.action && manifest.action.default_icon, 'action.default_icon is missing');

  for (const size of ICON_SIZES) {
    for (const declared of [manifest.icons, manifest.action.default_icon]) {
      const relative = declared[String(size)];
      assert.equal(relative, `icons/icon-${size}.png`);
      const file = path.join(ROOT, 'extension', relative);
      assert.ok(fs.existsSync(file), `${relative} does not exist`);

      const bytes = fs.readFileSync(file);
      assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${relative} is not a PNG`);
      assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
      assert.equal(bytes.readUInt32BE(16), size, `${relative} has the wrong width`);
      assert.equal(bytes.readUInt32BE(20), size, `${relative} has the wrong height`);
    }
  }
});

test('dashboard HTML links the SVG favicon and the file exists', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(
    html,
    /<link\s+rel="icon"\s+href="\/favicon\.svg"\s+type="image\/svg\+xml"\s*\/?>/i,
  );

  const favicon = path.join(ROOT, 'public', 'favicon.svg');
  assert.ok(fs.existsSync(favicon), 'public/favicon.svg does not exist');
  const svg = fs.readFileSync(favicon, 'utf8');
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /viewBox="0 0 64 64"/);
  assert.match(svg, /fill="#2563eb"/);
});
