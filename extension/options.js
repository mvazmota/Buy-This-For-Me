'use strict';

const form = document.getElementById('settings-form');
const urlInput = document.getElementById('backend-url');
const errorEl = document.getElementById('backend-error');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('save');

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
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

async function load() {
  urlInput.value = await getBackendUrl();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  hideStatus();
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';

  try {
    const saved = await setBackendUrl(urlInput.value);
    urlInput.value = saved;
    showStatus(
      isLocalBackend(saved)
        ? 'Saved. Requests will go to the local server.'
        : 'Saved. Requests will open the online dashboard in a new tab.',
      'success'
    );
  } catch (err) {
    showError(err.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save';
  }
});

urlInput.addEventListener('input', () => {
  showError('');
  hideStatus();
});

load();
