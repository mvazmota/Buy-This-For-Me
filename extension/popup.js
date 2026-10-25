'use strict';

let backendUrl = DEFAULT_BACKEND_URL;

const form = document.getElementById('request-form');
const titleInput = document.getElementById('title');
const quantityInput = document.getElementById('quantity');
const noteInput = document.getElementById('note');
const urlInput = document.getElementById('url');
const submitButton = document.getElementById('submit');
const statusEl = document.getElementById('status');
const pageHint = document.getElementById('page-hint');
const backendHint = document.getElementById('backend-hint');
const dashboardLink = document.getElementById('dashboard-link');
const optionsLink = document.getElementById('options-link');

const fieldErrors = {
  title: document.getElementById('title-error'),
  quantity: document.getElementById('quantity-error'),
  note: document.getElementById('note-error'),
  url: document.getElementById('url-error'),
};

function showStatus(message, kind = 'error') {
  statusEl.replaceChildren();
  statusEl.dataset.kind = kind;

  if (kind === 'success') {
    const text = document.createElement('span');
    text.textContent = `${message} `;
    const link = document.createElement('a');
    link.href = `${backendUrl}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open dashboard';
    statusEl.append(text, link);
  } else {
    statusEl.textContent = message;
  }

  statusEl.hidden = false;
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.textContent = '';
  statusEl.dataset.kind = '';
}

function clearFieldErrors() {
  for (const [field, element] of Object.entries(fieldErrors)) {
    element.textContent = '';
    element.hidden = true;
    const input = document.getElementById(field);
    if (input) input.removeAttribute('aria-invalid');
  }
}

function setFieldErrors(errors) {
  let firstInvalid = null;
  for (const [field, message] of Object.entries(errors)) {
    const element = fieldErrors[field];
    if (!element) continue;
    element.textContent = message;
    element.hidden = false;
    const input = document.getElementById(field);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      if (!firstInvalid) firstInvalid = input;
    }
  }
  if (firstInvalid) firstInvalid.focus();
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validate() {
  const errors = {};
  const title = titleInput.value.trim();
  const url = urlInput.value.trim();
  const note = noteInput.value.trim();
  const quantityRaw = quantityInput.value.trim();

  if (!title) {
    errors.title = 'Title is required.';
  } else if (title.length > 200) {
    errors.title = 'Title must be 200 characters or fewer.';
  }

  if (!url) {
    errors.url = 'Link is required.';
  } else if (!isHttpUrl(url)) {
    errors.url = 'Link must be a valid http:// or https:// address.';
  }

  if (note.length > 1000) {
    errors.note = 'Note must be 1000 characters or fewer.';
  }

  const quantity = Number(quantityRaw);
  if (!quantityRaw || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    errors.quantity = 'Quantity must be a whole number from 1 to 999.';
  }

  setFieldErrors(errors);
  if (Object.keys(errors).length > 0) {
    showStatus('Please fix the highlighted fields.', 'error');
    return null;
  }

  return { title, url, note, quantity };
}

async function applyBackend() {
  backendUrl = await getBackendUrl();
  dashboardLink.href = `${backendUrl}/`;
  dashboardLink.textContent = backendUrl;

  if (isLocalBackend(backendUrl)) {
    backendHint.hidden = true;
    backendHint.textContent = '';
  } else {
    backendHint.textContent =
      'Online dashboard: a new tab opens after you submit. Log in there if prompted; the request is sent once.';
    backendHint.hidden = false;
  }
}

async function prefillFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      pageHint.textContent = 'No active tab found. You can still enter an item manually.';
      pageHint.hidden = false;
      return;
    }

    if (tab.title) {
      titleInput.value = tab.title.slice(0, 200);
    }

    if (tab.url && isHttpUrl(tab.url)) {
      urlInput.value = tab.url;
    } else {
      pageHint.textContent =
        'This page is not a normal website (for example a browser or extension page), so its link was not filled in. Open the product page and click the extension again.';
      pageHint.hidden = false;
    }
  } catch (err) {
    pageHint.textContent = `Could not read the active tab: ${err.message}`;
    pageHint.hidden = false;
  }
}

function resetFormAfterSuccess() {
  form.reset();
  quantityInput.value = '1';
}

async function sendToLocal(payload) {
  try {
    const response = await fetch(`${backendUrl}/api/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (data.details && typeof data.details === 'object') {
        setFieldErrors(data.details);
        showStatus(data.error || 'The server rejected this request. Check the fields above.', 'error');
      } else {
        showStatus(data.error || `Server returned ${response.status}.`, 'error');
      }
      return false;
    }

    resetFormAfterSuccess();
    showStatus(`Sent “${data.request.title}”.`, 'success');
    return true;
  } catch (err) {
    const unreachable = err instanceof TypeError;
    showStatus(
      unreachable
        ? `Cannot reach the local server at ${backendUrl}. Start it with "npm start" in the project folder, then try again.`
        : `Could not send the request: ${err.message}`,
      'error'
    );
    return false;
  }
}

async function openRemoteDraft(payload) {
  // The remote Worker requires a login. Hand the request to the dashboard in
  // the URL fragment so it can submit after login, same-origin.
  const draftUrl = `${backendUrl}/#draft=${encodeURIComponent(JSON.stringify(payload))}`;
  try {
    // Log in happens on the dashboard, so bring the tab to the foreground.
    await chrome.tabs.create({ url: draftUrl, active: true });
    resetFormAfterSuccess();
    showStatus(
      'Opened the online dashboard in a new tab. Log in there if prompted; the request will be submitted once.',
      'success'
    );
    return true;
  } catch (err) {
    showStatus(`Could not open the dashboard tab: ${err.message}`, 'error');
    return false;
  }
}

async function submitRequest(event) {
  event.preventDefault();
  clearStatus();
  clearFieldErrors();

  const payload = validate();
  if (!payload) return;

  submitButton.disabled = true;
  submitButton.textContent = 'Sending…';

  try {
    await backendReady;
    const ok = isLocalBackend(backendUrl)
      ? await sendToLocal(payload)
      : await openRemoteDraft(payload);
    if (ok) await prefillFromActiveTab();
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Send request';
  }
}

const backendReady = applyBackend();

form.addEventListener('submit', submitRequest);
optionsLink.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

backendReady.then(prefillFromActiveTab);
