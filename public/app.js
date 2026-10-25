'use strict';

const STATUSES = ['New', 'Purchased', 'Done', 'Not buying'];
const REFRESH_MS = 15000;

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const loadingEl = document.getElementById('loading');
const bannerEl = document.getElementById('banner');
const summaryEl = document.getElementById('summary');
const refreshButton = document.getElementById('refresh');
const lastUpdatedEl = document.getElementById('last-updated');

let refreshTimer = null;

function showBanner(message, kind = 'error') {
  bannerEl.textContent = message;
  bannerEl.dataset.kind = kind;
  bannerEl.hidden = false;
}

function hideBanner() {
  bannerEl.hidden = true;
  bannerEl.textContent = '';
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
    showBanner(
      `Could not load requests: ${err.message}\n` +
        'Make sure the server is running (npm start in the project folder), then press Refresh.',
      'error'
    );
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', () => loadRequests());

// Refresh periodically, but never while a status select is focused.
function scheduleRefresh() {
  window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => {
    if (document.activeElement && document.activeElement.classList.contains('status-select')) {
      return;
    }
    loadRequests({ silent: true });
  }, REFRESH_MS);
}

loadRequests();
scheduleRefresh();
