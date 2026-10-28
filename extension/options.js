'use strict';

const form = document.getElementById('settings-form');
const urlInput = document.getElementById('backend-url');
const usernameInput = document.getElementById('app-username');
const passwordInput = document.getElementById('app-password');
const urlErrorEl = document.getElementById('backend-error');
const usernameErrorEl = document.getElementById('username-error');
const passwordErrorEl = document.getElementById('password-error');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('save');
const passwordToggle = document.getElementById('toggle-password');

function toggleInvalid(input, message) {
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function showUrlError(message) {
  urlErrorEl.textContent = message;
  urlErrorEl.hidden = !message;
  toggleInvalid(urlInput, message);
}

function showUsernameError(message) {
  usernameErrorEl.textContent = message;
  usernameErrorEl.hidden = !message;
  toggleInvalid(usernameInput, message);
}

function showPasswordError(message) {
  passwordErrorEl.textContent = message;
  passwordErrorEl.hidden = !message;
  toggleInvalid(passwordInput, message);
}

function clearErrors() {
  showUrlError('');
  showUsernameError('');
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
  usernameInput.value = await getAppUsername();
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

  const username = usernameInput.value.trim().toLowerCase();
  const password = passwordInput.value.trim();
  const remote = !isLocalBackend(saved);

  if (remote && !username) {
    showUsernameError('Enter your username for the online dashboard.');
    usernameInput.focus();
    return;
  }

  if (remote && !password) {
    showPasswordError('Enter your password for the online dashboard.');
    passwordInput.focus();
    return;
  }

  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';

  try {
    await setBackendUrl(saved);
    await setAppUsername(username);
    await setAppPassword(password, saved);
    urlInput.value = saved;
    usernameInput.value = username;
    passwordInput.value = password;
    showStatus(
      remote
        ? 'Saved. Requests will be sent directly to the online dashboard.'
        : 'Saved. Requests will go to the local server.',
      'success'
    );
  } catch (err) {
    showUsernameError(err.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save';
  }
});

urlInput.addEventListener('input', () => {
  showUrlError('');
  hideStatus();
});

usernameInput.addEventListener('input', () => {
  showUsernameError('');
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
