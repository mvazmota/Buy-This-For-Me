'use strict';

const STATUSES = ['New', 'Purchased', 'Done', 'Not buying'];
const REFRESH_MS = 15000;
const DRAFT_PREFIX = '#draft=';
const MAX_TITLE = 200;
const MAX_NOTE = 1000;
const MAX_URL = 2048;
const MAX_QUANTITY = 999;

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const loadingEl = document.getElementById('loading');
const bannerEl = document.getElementById('banner');
const summaryEl = document.getElementById('summary');
const refreshButton = document.getElementById('refresh');
const lastUpdatedEl = document.getElementById('last-updated');
const logoutButton = document.getElementById('logout');
const appView = document.getElementById('app-view');
const loginView = document.getElementById('login-view');
const loginForm = document.getElementById('login-form');
const loginErrorEl = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');
const passwordInput = document.getElementById('password');
const draftStatusEl = document.getElementById('draft-status');

let refreshTimer = null;
let authRequired = true;
let pendingDraft = null;
let draftSubmitting = false;
let startupNotice = '';

function showBanner(message, kind = 'error') {
  bannerEl.textContent = message;
  bannerEl.dataset.kind = kind;
  bannerEl.hidden = false;
}

function hideBanner() {
  bannerEl.hidden = true;
  bannerEl.textContent = '';
  bannerEl.dataset.kind = '';
}

function setDraftStatus(message, kind = 'info') {
  draftStatusEl.textContent = message;
  draftStatusEl.dataset.kind = kind;
  draftStatusEl.hidden = false;
}

function hideDraftStatus() {
  draftStatusEl.hidden = true;
  draftStatusEl.textContent = '';
  draftStatusEl.dataset.kind = '';
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function stopRefresh() {
  window.clearInterval(refreshTimer);
  refreshTimer = null;
}

function startRefresh() {
  stopRefresh();
  refreshTimer = window.setInterval(() => {
    if (document.activeElement && document.activeElement.classList.contains('status-select')) {
      return;
    }
    loadRequests({ silent: true });
  }, REFRESH_MS);
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  refreshButton.hidden = false;
  logoutButton.hidden = !authRequired;
  loginErrorEl.hidden = true;
  loginErrorEl.textContent = '';
  startRefresh();
}

function showLogin({ message = '', kind = 'info' } = {}) {
  stopRefresh();
  authRequired = true;
  appView.hidden = true;
  loginView.hidden = false;
  refreshButton.hidden = true;
  logoutButton.hidden = true;
  lastUpdatedEl.textContent = '';
  listEl.replaceChildren();
  summaryEl.hidden = true;
  emptyEl.hidden = true;
  loadingEl.hidden = true;
  hideDraftStatus();

  if (message) {
    showBanner(message, kind);
  } else {
    hideBanner();
  }

  passwordInput.focus();
}

function clearDraftFragment() {
  if (!window.location.hash.startsWith(DRAFT_PREFIX)) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

/**
 * Read the extension handoff from #draft=<encoded JSON>. The fragment is not
 * sent to the server, and is removed only after a successful submit.
 */
function readDraftFragment() {
  if (!window.location.hash.startsWith(DRAFT_PREFIX)) return null;

  const raw = window.location.hash.slice(DRAFT_PREFIX.length);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Fall back to the raw fragment; JSON.parse below decides if it is usable.
  }

  let payload;
  try {
    payload = JSON.parse(decoded);
  } catch {
    startupNotice = 'Could not read the request sent by the extension. Add it again from the extension.';
    clearDraftFragment();
    return null;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    startupNotice = 'The extension sent an invalid request. Add it again from the extension.';
    clearDraftFragment();
    return null;
  }

  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  const note = typeof payload.note === 'string' ? payload.note.trim() : '';
  const quantity = payload.quantity === undefined || payload.quantity === null ? 1 : payload.quantity;

  const valid =
    title.length > 0 &&
    title.length <= MAX_TITLE &&
    isHttpUrl(url) &&
    url.length <= MAX_URL &&
    note.length <= MAX_NOTE &&
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= MAX_QUANTITY;

  if (!valid) {
    startupNotice =
      'The request sent by the extension has invalid fields. Add it again from the extension.';
    clearDraftFragment();
    return null;
  }

  return { title, url, note, quantity };
}

function setLoginError(message) {
  loginErrorEl.textContent = message;
  loginErrorEl.hidden = !message;
}

async function submitPendingDraft() {
  if (!pendingDraft || draftSubmitting) return;
  draftSubmitting = true;
  const draft = pendingDraft;
  setDraftStatus(`Sending “${draft.title}” from the extension…`, 'info');

  try {
    const response = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      showLogin({ message: 'Your session expired. Log in again to send this request.' });
      return;
    }

    if (!response.ok) {
      const firstDetail =
        data.details && typeof data.details === 'object' ? Object.values(data.details)[0] : '';
      throw new Error(firstDetail || data.error || `Server returned ${response.status}.`);
    }

    pendingDraft = null;
    clearDraftFragment();
    hideBanner();
    setDraftStatus(`Added “${data.request.title}” from the extension.`, 'success');
    await loadRequests({ silent: true });
  } catch (err) {
    setDraftStatus(
      `Could not add the extension request: ${err.message} ` +
        'The draft is still in the address bar; refresh the page to retry.',
      'error'
    );
  } finally {
    draftSubmitting = false;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  setLoginError('');
  hideBanner();

  if (!passwordInput.value) {
    setLoginError('Enter the app password.');
    passwordInput.focus();
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = 'Logging in…';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 503) {
        setLoginError('Login is not available on this server. Check that APP_PASSWORD is configured.');
      } else {
        setLoginError('Login failed. Check the password and try again.');
      }
      passwordInput.select();
      return;
    }

    passwordInput.value = '';
    authRequired = data.authRequired !== false;
    showApp();
    await loadRequests();
    await submitPendingDraft();
  } catch {
    setLoginError('Could not reach the server. Try again.');
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Log in';
  }
}

async function handleLogout() {
  logoutButton.disabled = true;
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Server returned ${response.status}.`);
    }

    if (data.authenticated) {
      // Local mode has no password, so logout keeps the session active.
      authRequired = data.authRequired !== false;
      showApp();
      await loadRequests({ silent: true });
      return;
    }

    showLogin({ message: 'Logged out.' });
  } catch (err) {
    showBanner(`Could not log out: ${err.message}`, 'error');
  } finally {
    logoutButton.disabled = false;
  }
}

function buildCard(request) {
  const card = document.createElement('article');
  card.className = 'request-card';
  card.dataset.id = request.id;

  const main = document.createElement('div');
  main.className = 'request-main';

  const title = document.createElement('h2');
  title.className = 'request-title';
  if (isHttpUrl(request.url)) {
    const link = document.createElement('a');
    link.href = request.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = request.title;
    title.appendChild(link);
  } else {
    title.textContent = request.title;
  }
  main.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'request-meta';
  meta.textContent = `Added ${formatTime(request.submittedAt)}`;
  main.appendChild(meta);

  if (request.note) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = request.note;
    main.appendChild(note);
  }

  const side = document.createElement('div');
  side.className = 'request-side';

  const qty = document.createElement('span');
  qty.className = 'qty';
  qty.textContent = `Qty ${request.quantity}`;
  side.appendChild(qty);

  const select = document.createElement('select');
  select.className = 'status-select';
  select.dataset.status = request.status;
  select.setAttribute('aria-label', `Status for ${request.title}`);
  for (const status of STATUSES) {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = status;
    if (status === request.status) option.selected = true;
    select.appendChild(option);
  }

  const statusError = document.createElement('p');
  statusError.className = 'status-error';
  statusError.hidden = true;

  select.addEventListener('change', async () => {
    const nextStatus = select.value;
    const previousStatus = select.dataset.status;
    select.disabled = true;
    statusError.hidden = true;

    try {
      const response = await fetch(`/api/requests/${encodeURIComponent(request.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        showLogin({ message: 'Your session expired. Log in again to change requests.' });
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || `Server returned ${response.status}.`);
      }
      select.dataset.status = nextStatus;
      select.value = nextStatus;
      hideBanner();
      await loadRequests({ silent: true });
    } catch (err) {
      select.value = previousStatus;
      statusError.textContent = `Not saved: ${err.message}`;
      statusError.hidden = false;
      showBanner(`Could not update status: ${err.message}`, 'error');
    } finally {
      select.disabled = false;
    }
  });

  side.appendChild(select);
  side.appendChild(statusError);

  card.appendChild(main);
  card.appendChild(side);
  return card;
}

function render(requests) {
  listEl.replaceChildren();
  summaryEl.hidden = requests.length === 0;
  emptyEl.hidden = requests.length !== 0;
  loadingEl.hidden = true;

  const open = requests.filter((request) => request.status === 'New').length;
  summaryEl.textContent =
    requests.length === 1
      ? `1 request · ${open} marked New`
      : `${requests.length} requests · ${open} marked New`;

  for (const request of requests) {
    listEl.appendChild(buildCard(request));
  }
}

async function loadRequests({ silent = false } = {}) {
  if (!silent) {
    loadingEl.hidden = false;
    refreshButton.disabled = true;
  }

  try {
    const response = await fetch('/api/requests', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      showLogin({ message: 'Your session expired. Log in again to view requests.' });
      return;
    }

    if (!response.ok) {
      throw new Error(data.error || `Server returned ${response.status}.`);
    }
    if (!Array.isArray(data.requests)) {
      throw new Error('Unexpected response from server.');
    }
    hideBanner();
    render(data.requests);
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    loadingEl.hidden = true;
  } catch (err) {
    loadingEl.hidden = true;
    showBanner(`Could not load requests: ${err.message} Press Refresh to try again.`, 'error');
  } finally {
    refreshButton.disabled = false;
  }
}

async function checkSession() {
  try {
    const response = await fetch('/api/session', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Server returned ${response.status}.`);
    }

    authRequired = data.authRequired !== false;
    const notice = startupNotice;
    startupNotice = '';

    if (!data.authenticated) {
      showLogin({
        message:
          notice || (pendingDraft ? 'Log in to add the request sent from the extension.' : ''),
      });
      return;
    }

    showApp();
    await loadRequests();
    if (notice) showBanner(notice, 'error');
    await submitPendingDraft();
  } catch (err) {
    // Show the shell so the message is actionable; no data has been rendered.
    authRequired = true;
    showApp();
    loadingEl.hidden = true;
    showBanner(`Could not check login: ${err.message}`, 'error');
  }
}

async function init() {
  pendingDraft = readDraftFragment();
  await checkSession();
}

loginForm.addEventListener('submit', handleLogin);
refreshButton.addEventListener('click', () => loadRequests());
logoutButton.addEventListener('click', handleLogout);

init();
