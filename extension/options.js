'use strict';

const form = document.getElementById('settings-form');
const urlInput = document.getElementById('backend-url');
const passwordInput = document.getElementById('app-password');
const urlErrorEl = document.getElementById('backend-error');
const passwordErrorEl = document.getElementById('password-error');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('save');
const passwordToggle = document.getElementById('toggle-password');

function showUrlError(message) {
  urlErrorEl.textContent = message;
  urlErrorEl.hidden = !message;
  urlInput.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function showPasswordError(message) {
  passwordErrorEl.textContent = message;
  passwordErrorEl.hidden = !message;
  passwordInput.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function clearErrors() {
  showUrlError('');
  showPasswordError('');
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
  passwordInput.value = await getAppPassword();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  hideStatus();

  let saved;
  try {
    saved = normalizeBackendUrl(urlInput.value);
  } catch (err) {
    showUrlError(err.message);
    urlInput.focus();
    return;
  }

  const password = passwordInput.value.trim();
  if (!isLocalBackend(saved) && !password) {
    showPasswordError('Enter the app password for the online dashboard.');
    passwordInput.focus();
    return;
  }

  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';

  try {
    await setBackendUrl(saved);
    await setAppPassword(password, saved);
    urlInput.value = saved;
    passwordInput.value = password;
    showStatus(
      isLocalBackend(saved)
        ? 'Saved. Requests will go to the local server.'
        : 'Saved. Requests will be sent directly to the online dashboard.',
      'success'
    );
  } catch (err) {
    showUrlError(err.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save';
  }
});

urlInput.addEventListener('input', () => {
  showUrlError('');
  hideStatus();
});

passwordInput.addEventListener('input', () => {
  showPasswordError('');
  hideStatus();
});

// Show/hide toggle: presentation only. The stored value is untouched.
passwordToggle.addEventListener('click', () => {
  const reveal = passwordInput.type === 'password';
  passwordInput.type = reveal ? 'text' : 'password';
  passwordToggle.textContent = reveal ? 'Hide' : 'Show';
  passwordToggle.setAttribute('aria-pressed', String(reveal));
  passwordToggle.setAttribute('aria-label', reveal ? 'Hide app password' : 'Show app password');
  passwordInput.focus();
});

load();
