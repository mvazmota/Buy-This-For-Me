'use strict';

const form = document.getElementById('settings-form');
const urlInput = document.getElementById('backend-url');
const urlErrorEl = document.getElementById('backend-error');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('save');
const accountState = document.getElementById('account-state');
const logoutButton = document.getElementById('logout');

function showUrlError(message) {
  urlErrorEl.textContent = message;
  urlErrorEl.hidden = !message;
  urlInput.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function showStatus(message, kind = 'success') {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
  statusEl.hidden = false;
}

function hideStatus() {
  statusEl.hidden = true;
  statusEl.textContent = '';
  statusEl.dataset.kind = '';
}

async function renderAccount() {
  const backend = await getBackendUrl();
  if (isLocalBackend(backend)) {
    accountState.textContent = 'Using the local server, which does not require a login.';
    logoutButton.hidden = true;
    return;
  }

  const username = await getAppUsername();
  accountState.textContent = username
    ? `Signed in as ${username}. Log out to switch accounts.`
    : 'Not logged in. Open the extension popup to log in.';
  logoutButton.hidden = !username;
}

async function load() {
  urlInput.value = await getBackendUrl();
  await renderAccount();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showUrlError('');
  hideStatus();

  let saved;
  try {
    saved = normalizeBackendUrl(urlInput.value);
  } catch (err) {
    showUrlError(err.message);
    urlInput.focus();
    return;
  }

  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';

  try {
    await setBackendUrl(saved);
    urlInput.value = saved;
    await renderAccount();
    showStatus('Saved.', 'success');
  } catch (err) {
    showUrlError(err.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save';
  }
});

logoutButton.addEventListener('click', async () => {
  await clearAppCredentials();
  hideStatus();
  await renderAccount();
  showStatus('Logged out.', 'success');
});

urlInput.addEventListener('input', () => {
  showUrlError('');
  hideStatus();
});

load();
