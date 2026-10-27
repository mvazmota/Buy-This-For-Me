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

const { normalizeUrl, findDuplicateRequest } = require('../extension/url-utils');

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
function loadPopup({
  backendUrl = REMOTE_URL,
  appPassword = 'family secret',
  fetchImpl,
  scriptingPrice = null,
  denyInjection = false,
} = {}) {
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
  const injected = [];
  const stored = {};
  if (backendUrl !== null) stored.backendUrl = backendUrl;
  if (appPassword !== null) stored.appPassword = appPassword;

  const chrome = {
    storage: {
      local: {
        async get(key) {
          if (key === undefined) return { ...stored };
          return key in stored ? { [key]: stored[key] } : {};
        },
        async set(values) {
          Object.assign(stored, values);
        },
      },
    },
    tabs: {
      async create(options) {
        createdTabs.push(options);
        return { id: createdTabs.length, ...options };
      },
      async query() {
        return [{ id: 42, title: 'Example product', url: 'https://example.com/product' }];
      },
    },
    scripting: {
      async executeScript(options) {
        injected.push(options);
        if (denyInjection) throw new Error('Cannot access contents of the page.');
        // The file injection only loads the extractor; the follow-up func
        // returns whatever the page "found".
        if (options.files) return [];
        return [{ result: scriptingPrice }];
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
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl || (async () => {
      throw new Error('Unexpected fetch in extension test.');
    }),
  });

  for (const file of ['settings.js', 'url-utils.js', 'price-extractor.js', 'popup.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', file), 'utf8');
    const suffix =
      file === 'popup.js'
        ? '\n;globalThis.__popupTest = { sendToRemote, sendToLocal, backendReady, getBackendUrl, getAppPassword, setAppPassword, submitRequest, confirmDuplicate, cancelDuplicate, checkDuplicate, validate, prefillFromActiveTab, autoFillPriceFromPage, updatePriceDisplay, getPendingPayload: () => pendingPayload };'
        : '';
    vm.runInContext(source + suffix, context, { filename: file });
  }

  return { ...context.__popupTest, elements, createdTabs, injected, stored };
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fillForm(elements, values = {}) {
  const fields = {
    title: 'Running shoes',
    url: 'https://example.com/shoes',
    quantity: '2',
    price: '',
    note: '',
    ...values,
  };
  for (const [field, value] of Object.entries(fields)) {
    elements.get(field).value = value;
  }
}

test('no stored backend URL falls back to the deployed Worker URL', async () => {
  const { getBackendUrl } = loadPopup({ backendUrl: null });
  assert.equal(await getBackendUrl(), WORKER_URL);
});

test('an explicitly saved backend URL is not replaced by the default', async () => {
  const { getBackendUrl } = loadPopup({ backendUrl: LOCAL_URL });
  assert.equal(await getBackendUrl(), LOCAL_URL);
});

test('remote submissions post directly to the Worker with the saved app password', async () => {
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

  const { sendToRemote, backendReady, elements, createdTabs } = loadPopup({ fetchImpl });
  await backendReady;

  const payload = {
    title: 'Running shoes',
    url: 'https://example.com/shoes',
    note: 'Size 43',
    quantity: 2,
  };
  assert.equal(await sendToRemote(payload), true);

  assert.equal(createdTabs.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${REMOTE_URL}/api/requests`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers['X-App-Password'], 'family secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);

  const status = elements.get('status');
  assert.equal(status.hidden, false);
  assert.equal(status.dataset.kind, 'success');
  assert.equal(status.children[0].textContent, 'Sent “Running shoes”. ');
  assert.equal(status.children[1].textContent, 'Open dashboard');
  assert.equal(status.children[1].href, `${REMOTE_URL}/`);
});

test('a rejected remote password points at the extension settings', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    async json() {
      return { error: 'Authentication required.' };
    },
  });

  const { sendToRemote, backendReady, elements, createdTabs } = loadPopup({ fetchImpl });
  await backendReady;

  const payload = {
    title: 'Running shoes',
    url: 'https://example.com/shoes',
    note: '',
    quantity: 1,
  };
  assert.equal(await sendToRemote(payload), false);
  assert.equal(createdTabs.length, 0);
  assert.equal(
    elements.get('status').textContent,
    'Password is missing or wrong. Update it in Settings.'
  );
});

test('an unreachable remote server reports a network error', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };

  const { sendToRemote, backendReady, elements } = loadPopup({ fetchImpl });
  await backendReady;

  const payload = {
    title: 'Running shoes',
    url: 'https://example.com/shoes',
    note: '',
    quantity: 1,
  };
  assert.equal(await sendToRemote(payload), false);
  assert.match(elements.get('status').textContent, /Cannot reach the server/);
});

test('app password saves trimmed, must not be empty for a remote backend, may be empty locally', async () => {
  const { getAppPassword, setAppPassword, stored } = loadPopup({ appPassword: null });

  assert.equal(await getAppPassword(), '');
  await assert.rejects(() => setAppPassword('   ', REMOTE_URL), /app password/i);

  assert.equal(await setAppPassword('  family secret  ', REMOTE_URL), 'family secret');
  assert.equal(stored.appPassword, 'family secret');
  assert.equal(await getAppPassword(), 'family secret');

  assert.equal(await setAppPassword('', LOCAL_URL), '');
  assert.equal(stored.appPassword, '');
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

test('normalizeUrl ignores tracking params, fragments, trailing slashes and host case', () => {
  assert.equal(
    normalizeUrl('HTTPS://Example.COM/Path/?utm_source=news&b=2&a=1#frag'),
    'https://example.com/Path?a=1&b=2'
  );
  assert.equal(
    normalizeUrl('https://example.com/item/?fbclid=1&gclid=2&ref=abc&tag=x&_ga=1'),
    'https://example.com/item'
  );
  assert.equal(normalizeUrl('https://example.com/item///?utm_medium=email'), 'https://example.com/item');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/?utm_campaign=x'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/a?ref_src=newsletter'), 'https://example.com/a');
  assert.equal(normalizeUrl('  https://example.com/a  '), 'https://example.com/a');

  // Non-comparable input normalizes to an empty string.
  assert.equal(normalizeUrl('not a url'), '');
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
  assert.equal(normalizeUrl('ftp://example.com/file'), '');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(null), '');
});

test('findDuplicateRequest matches equivalent links only', () => {
  const requests = [
    { id: 'b', title: 'Bread', url: 'https://Bakery.example/loaf/#reviews' },
    { id: 'm', title: 'Milk', url: 'https://shop.example/milk?utm_source=app' },
  ];

  assert.equal(findDuplicateRequest(requests, 'https://shop.example/milk/').id, 'm');
  assert.equal(findDuplicateRequest(requests, 'https://bakery.example/loaf').id, 'b');
  assert.equal(findDuplicateRequest(requests, 'https://shop.example/eggs'), null);
  assert.equal(findDuplicateRequest(requests, 'not a url'), null);
  assert.equal(findDuplicateRequest(null, 'https://shop.example/milk'), null);
});

test('popup warns about a duplicate and sends nothing until confirmed', async () => {
  const calls = [];
  const existing = {
    id: 'existing',
    title: 'Running shoes',
    url: 'https://EXAMPLE.com/shoes/?utm_source=mail#top',
    status: 'Purchased',
  };

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { requests: [existing] };
        },
      };
    }
    return {
      ok: true,
      status: 201,
      async json() {
        return { request: { title: 'Running shoes' } };
      },
    };
  };

  const context = loadPopup({ fetchImpl });
  await context.backendReady;
  await flushAsync();
  fillForm(context.elements);

  assert.equal(await context.submitRequest({ preventDefault() {} }), undefined);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${REMOTE_URL}/api/requests`);
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.headers['X-App-Password'], 'family secret');

  const warning = context.elements.get('duplicate-warning');
  assert.equal(warning.hidden, false);
  const message = context.elements.get('duplicate-message').textContent;
  assert.match(message, /Running shoes/);
  assert.match(message, /Purchased/);
  assert.ok(context.getPendingPayload());

  assert.equal(await context.confirmDuplicate(), undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(JSON.parse(calls[1].options.body).title, 'Running shoes');
  assert.equal(warning.hidden, true);
  assert.equal(context.getPendingPayload(), null);
});

test('popup posts normally when no duplicate exists', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) {
      return { ok: true, status: 200, async json() { return { requests: [] }; } };
    }
    return {
      ok: true,
      status: 201,
      async json() { return { request: { title: 'Running shoes' } }; },
    };
  };

  const context = loadPopup({ fetchImpl });
  await context.backendReady;
  await flushAsync();
  fillForm(context.elements);

  await context.submitRequest({ preventDefault() {} });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(context.elements.get('duplicate-warning').hidden, true);
  assert.equal(context.elements.get('status').dataset.kind, 'success');
});

test('a failed duplicate check warns but still allows sending', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) throw new TypeError('Failed to fetch');
    return {
      ok: true,
      status: 201,
      async json() { return { request: { title: 'Running shoes' } }; },
    };
  };

  const context = loadPopup({ fetchImpl });
  await context.backendReady;
  await flushAsync();
  fillForm(context.elements);

  await context.submitRequest({ preventDefault() {} });

  assert.equal(calls.length, 1);
  assert.equal(context.elements.get('duplicate-warning').hidden, false);
  assert.match(context.elements.get('duplicate-message').textContent, /Could not check/);
  assert.ok(context.getPendingPayload());

  await context.confirmDuplicate();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
});

test('cancel drops the pending duplicate without sending', async () => {
  const calls = [];
  const existing = { id: 'x', title: 'Milk', url: 'https://shop.example/milk', status: 'New' };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) {
      return { ok: true, status: 200, async json() { return { requests: [existing] }; } };
    }
    return { ok: true, status: 201, async json() { return { request: { title: 'Milk' } }; } };
  };

  const context = loadPopup({ fetchImpl });
  await context.backendReady;
  await flushAsync();
  fillForm(context.elements, { title: 'Milk', url: 'https://shop.example/milk' });

  await context.submitRequest({ preventDefault() {} });
  assert.equal(calls.length, 1);
  context.cancelDuplicate();

  assert.equal(context.getPendingPayload(), null);
  assert.equal(context.elements.get('duplicate-warning').hidden, true);
  assert.equal(calls.length, 1);
});

test('popup sends price only when provided and validates its format', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) {
      return { ok: true, status: 200, async json() { return { requests: [] }; } };
    }
    return {
      ok: true,
      status: 201,
      async json() { return { request: { title: 'Running shoes' } }; },
    };
  };

  const context = loadPopup({ fetchImpl });
  await context.backendReady;
  await flushAsync();

  fillForm(context.elements);
  await context.submitRequest({ preventDefault() {} });
  const withoutPrice = JSON.parse(calls[1].options.body);
  assert.equal('price' in withoutPrice, false);

  calls.length = 0;
  context.elements.get('duplicate-warning').hidden = true;
  fillForm(context.elements, { price: '12.99' });
  await context.submitRequest({ preventDefault() {} });
  assert.equal(JSON.parse(calls[1].options.body).price, 12.99);

  calls.length = 0;
  fillForm(context.elements, { price: '12.999' });
  await context.submitRequest({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.equal(context.elements.get('price-error').hidden, false);
  assert.match(context.elements.get('price-error').textContent, /2 decimals/);
});

test('popup auto-fills an empty price from the page and shows a euro hint', async () => {
  const context = loadPopup({ scriptingPrice: 12.5 });
  await context.backendReady;
  await flushAsync();

  assert.equal(context.elements.get('price').value, '12.50');
  assert.equal(context.elements.get('price-hint').hidden, false);
  assert.equal(
    context.elements.get('price-hint').textContent,
    'Price found on the page — check it.'
  );
  const display = context.elements.get('price-display');
  assert.equal(display.hidden, false);
  assert.equal(
    display.textContent,
    new Intl.NumberFormat('pt-PT', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(12.5)
  );
  assert.ok(display.textContent.includes('€'));

  // One canonical extractor: inject the file, then call it from the page.
  assert.equal(context.injected.length, 2);
  assert.equal(context.injected[0].files.length, 1);
  assert.equal(context.injected[0].files[0], 'price-extractor.js');
  assert.equal(context.injected[0].target.tabId, 42);
  assert.equal(typeof context.injected[1].func, 'function');
});

test('auto-fill never overwrites a price the user already typed', async () => {
  const context = loadPopup({ scriptingPrice: 4 });
  await context.backendReady;
  await flushAsync();
  assert.equal(context.elements.get('price').value, '4.00');

  context.elements.get('price').value = '7.50';

  await context.autoFillPriceFromPage({ id: 42, url: 'https://example.com/product' });

  assert.equal(context.elements.get('price').value, '7.50');
});

test('auto-fill is silent when no price is found or injection is denied', async () => {
  const none = loadPopup({ scriptingPrice: null });
  await none.backendReady;
  await flushAsync();
  assert.equal(none.elements.get('price').value, '');
  assert.equal(none.elements.get('price-hint').textContent, '');
  assert.equal(none.elements.get('price-display').textContent, '');

  const denied = loadPopup({ denyInjection: true });
  await denied.backendReady;
  await flushAsync();
  assert.equal(denied.elements.get('price').value, '');
  assert.equal(denied.elements.get('price-hint').textContent, '');
});

test('auto-fill skips pages that are not http or https', async () => {
  const context = loadPopup({ scriptingPrice: 9.99 });
  await context.backendReady;
  await flushAsync();
  const before = context.injected.length;

  await context.autoFillPriceFromPage({ id: 1, url: 'edge://extensions/' });
  await context.autoFillPriceFromPage({ id: 1, url: 'chrome://settings/' });
  await context.autoFillPriceFromPage({ id: 1, url: 'about:blank' });
  assert.equal(context.injected.length, before);

  await context.autoFillPriceFromPage({ id: 1, url: 'https://example.com/product' });
  assert.equal(context.injected.length, before + 2);
  assert.equal(context.elements.get('price').value, '9.99');
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

test('manifest allows direct Worker and local-server calls without losing storage', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'),
  );

  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1:3000/*'));
  assert.ok(manifest.host_permissions.includes('http://localhost:3000/*'));
  assert.ok(manifest.host_permissions.includes(`${WORKER_URL}/*`));
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

function readExtensionPage(page) {
  const dir = path.join(ROOT, 'extension');
  return {
    html: fs.readFileSync(path.join(dir, `${page}.html`), 'utf8'),
    js: fs.readFileSync(path.join(dir, `${page}.js`), 'utf8'),
  };
}

function collectIds(html) {
  const ids = new Set();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]);
  return ids;
}

function collectGetElementById(js) {
  const ids = new Set();
  for (const match of js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) ids.add(match[1]);
  return ids;
}

test('every element ID used by the popup and options scripts exists in its HTML', () => {
  for (const page of ['popup', 'options']) {
    const { html, js } = readExtensionPage(page);
    const present = collectIds(html);
    const referenced = collectGetElementById(js);

    assert.ok(referenced.size > 0, `${page}.js references no element IDs`);
    for (const id of referenced) {
      assert.ok(present.has(id), `${page}.js references #${id}, missing from ${page}.html`);
    }

    // Duplicate ids would make getElementById ambiguous.
    const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(allIds).size, allIds.length, `${page}.html has duplicate IDs`);
  }
});

test('popup and options markup stays CSP-safe', () => {
  for (const page of ['popup', 'options']) {
    const { html } = readExtensionPage(page);

    assert.ok(!/<style[\s>]/i.test(html), `${page}.html has a <style> block`);
    assert.ok(!/\sstyle="/i.test(html), `${page}.html has an inline style attribute`);
    assert.ok(!/\son[a-z]+="/i.test(html), `${page}.html has an inline event handler`);

    for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
      assert.match(match[1], /\ssrc="/i, `${page}.html has an inline <script>`);
    }
  }
});

test('the removed online-only backend hint stays gone', () => {
  const { html, js } = readExtensionPage('popup');
  const removed =
    'Online dashboard: requests are sent directly from this popup. Save the app password in Settings.';

  assert.ok(!js.includes(removed), 'popup.js still sets the removed hint text');
  assert.ok(!html.includes('backend-hint'), 'popup.html still has the backend hint element');
  assert.ok(!js.includes('backend-hint'), 'popup.js still looks up the backend hint element');

  // The compact Online/Local badge replaces it.
  assert.match(html, /id="backend-mode"/);
  assert.match(js, /backendMode\.textContent = local \? 'Local' : 'Online'/);
});
