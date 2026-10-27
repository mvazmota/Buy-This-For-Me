'use strict';

const STATUSES = ['New', 'Purchased', 'Done', 'Not buying'];
const REFRESH_MS = 15000;
const STORAGE_KEY = 'bifm.dashboard.list-state.v1';
const DEFAULT_STATE = Object.freeze({ query: '', status: 'all', sort: 'newest' });
const SORT_VALUES = ['newest', 'oldest', 'title', 'quantity', 'price', 'status'];

// Keep these in sync with lib/validate.js (the server is the final authority).
const LIMITS = {
  title: 200,
  note: 1000,
  url: 2048,
  quantity: 999,
  price: 1000000,
};

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const emptyFilteredEl = document.getElementById('empty-filtered');
const loadingEl = document.getElementById('loading');
const bannerEl = document.getElementById('banner');
const summaryEl = document.getElementById('summary');
const statTotalEl = document.getElementById('stat-total');
const statOpenEl = document.getElementById('stat-open');
const statPurchasedEl = document.getElementById('stat-purchased');
const controlsEl = document.getElementById('controls');
const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');
const clearFiltersButton = document.getElementById('clear-filters');
const chipButtons = Array.from(document.querySelectorAll('.chip'));
const refreshButton = document.getElementById('refresh');
const lastUpdatedEl = document.getElementById('last-updated');
const logoutButton = document.getElementById('logout');
const appView = document.getElementById('app-view');
const loginView = document.getElementById('login-view');
const loginForm = document.getElementById('login-form');
const loginErrorEl = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');
const passwordInput = document.getElementById('password');
const deleteDialog = document.getElementById('delete-dialog');
const deleteDialogItem = document.getElementById('delete-dialog-item');
const deleteConfirmButton = document.getElementById('delete-confirm');
const deleteCancelButton = document.getElementById('delete-cancel');

let refreshTimer = null;
let authRequired = true;
let allRequests = [];
let lastPayload = '';
let listState = readStoredState();
// Set while the delete confirmation is open: { id, title, button }.
let pendingDelete = null;
let deleteInFlight = false;
// Bumped after a delete so an in-flight list refresh cannot resurrect the card.
let listRevision = 0;

function readStoredState() {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      query: typeof parsed.query === 'string' ? parsed.query.slice(0, 200) : '',
      status:
        parsed.status === 'all' || STATUSES.includes(parsed.status) ? parsed.status : 'all',
      sort: SORT_VALUES.includes(parsed.sort) ? parsed.sort : 'newest',
    };
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); fall back to
    // in-memory filtering.
    return { ...DEFAULT_STATE };
  }
}

function saveStoredState() {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(listState));
  } catch {
    // Filtering still works for this page view without sessionStorage.
  }
}

function hasActiveFilters() {
  return listState.query.trim() !== '' || listState.status !== 'all';
}

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

function hasPrice(request) {
  return (
    request.price !== null &&
    request.price !== undefined &&
    request.price !== '' &&
    Number.isFinite(Number(request.price))
  );
}

// The edit inputs stay plain numbers so type="number" keeps working; the hint
// under the price field shows the euro amount with the shared formatter.
function formatEditPriceHint(rawValue) {
  const text = String(rawValue === null || rawValue === undefined ? '' : rawValue).trim();
  if (!text) return '';
  const value = Number(text);
  return Number.isFinite(value) ? BIFMList.formatPrice(value) : '';
}

/**
 * Validate the inline edit form with the same rules as the server.
 * Returns { value, errors }; value is only used when errors is empty.
 */
function validateEdit(values) {
  const errors = {};
  const title = values.title.trim();
  const url = values.url.trim();
  const note = values.note.trim();
  const quantityRaw = values.quantity.trim();
  const priceRaw = values.price.trim();

  if (!title) {
    errors.title = 'Title is required.';
  } else if (title.length > LIMITS.title) {
    errors.title = `Title must be ${LIMITS.title} characters or fewer.`;
  }

  if (!url) {
    errors.url = 'URL is required.';
  } else if (url.length > LIMITS.url) {
    errors.url = `URL must be ${LIMITS.url} characters or fewer.`;
  } else if (!isHttpUrl(url)) {
    errors.url = 'URL must be a valid http:// or https:// address.';
  }

  if (note.length > LIMITS.note) {
    errors.note = `Note must be ${LIMITS.note} characters or fewer.`;
  }

  const quantity = Number(quantityRaw);
  if (!quantityRaw || !Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.quantity) {
    errors.quantity = `Quantity must be a whole number from 1 to ${LIMITS.quantity}.`;
  }

  let price = null;
  if (priceRaw) {
    price = Number(priceRaw);
    if (!Number.isFinite(price) || price < 0 || price > LIMITS.price) {
      errors.price = `Price must be a number from 0 to ${LIMITS.price}.`;
    } else if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) {
      errors.price = 'Price can have at most 2 decimals.';
    }
  }

  return {
    errors,
    value: { title, url, note, quantity, price },
  };
}

function stopRefresh() {
  window.clearInterval(refreshTimer);
  refreshTimer = null;
}

function isEditing() {
  // Never re-render over an open inline edit form, even when focus is on a button.
  if (listEl.querySelector('.request-edit:not([hidden])')) return true;
  const active = document.activeElement;
  if (!active || !appView.contains(active)) return false;
  return active.matches('input, select, textarea');
}

function supportsDeleteDialog() {
  return Boolean(deleteDialog) && typeof deleteDialog.showModal === 'function';
}

function isDeleteDialogOpen() {
  return supportsDeleteDialog() && deleteDialog.open;
}

/**
 * Run the DELETE call for one card. Removes the card from the local list on
 * success and re-renders so stats, filter counts, and the empty state follow.
 */
async function deleteRequest(target) {
  if (deleteInFlight) return;
  deleteInFlight = true;

  const { id, button } = target;
  const buttonLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Deleting…';

  try {
    const response = await fetch(`/api/requests/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      showLogin({ message: 'Your session expired. Log in again to change requests.' });
      return;
    }

    if (!response.ok) {
      throw new Error(data.error || `Server returned ${response.status}.`);
    }

    allRequests = BIFMList.removeRequestById(allRequests, id);
    lastPayload = JSON.stringify(allRequests);
    listRevision += 1;
    hideBanner();
    render();
  } catch (err) {
    showBanner(`Could not delete request: ${err.message}`, 'error');
  } finally {
    deleteInFlight = false;
    // A successful render() replaces the card, so the button may be gone.
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = buttonLabel;
    }
  }
}

/**
 * Ask before deleting. Uses a native modal <dialog> when available and falls
 * back to window.confirm in older browsers.
 */
function askDelete(target) {
  if (deleteInFlight) return;

  if (!supportsDeleteDialog()) {
    if (window.confirm(`Delete "${target.title}"? This cannot be undone.`)) {
      deleteRequest(target);
    }
    return;
  }

  pendingDelete = target;
  deleteDialogItem.textContent = target.title;
  deleteDialog.showModal();
  // Cancel is the default action, so Enter is safe and Escape just closes.
  deleteCancelButton.focus();
}

function closeDeleteDialog() {
  pendingDelete = null;
  if (supportsDeleteDialog() && deleteDialog.open) {
    deleteDialog.close();
  }
}

function startRefresh() {
  stopRefresh();
  refreshTimer = window.setInterval(() => {
    if (isEditing() || isDeleteDialogOpen()) return;
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
  closeDeleteDialog();
  authRequired = true;
  allRequests = [];
  lastPayload = '';
  appView.hidden = true;
  loginView.hidden = false;
  refreshButton.hidden = true;
  logoutButton.hidden = true;
  lastUpdatedEl.textContent = '';
  listEl.replaceChildren();
  summaryEl.hidden = true;
  controlsEl.hidden = true;
  emptyEl.hidden = true;
  emptyFilteredEl.hidden = true;
  loadingEl.hidden = true;

  if (message) {
    showBanner(message, kind);
  } else {
    hideBanner();
  }

  passwordInput.focus();
}

function setLoginError(message) {
  loginErrorEl.textContent = message;
  loginErrorEl.hidden = !message;
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

function createEditField(request, { name, label, value, type = 'text', multiline = false, maxLength, min, max, step, hint = false }) {
  const wrapper = document.createElement('div');
  wrapper.className = `edit-field edit-${name}`;

  const inputId = `edit-${request.id}-${name}`;
  const labelEl = document.createElement('label');
  labelEl.htmlFor = inputId;
  labelEl.textContent = label;
  wrapper.appendChild(labelEl);

  const input = document.createElement(multiline ? 'textarea' : 'input');
  input.id = inputId;
  input.name = name;
  if (multiline) {
    input.rows = 3;
  } else {
    input.type = type;
  }
  if (maxLength) input.maxLength = maxLength;
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  input.value = value === null || value === undefined ? '' : String(value);
  wrapper.appendChild(input);

  let hintEl = null;
  if (hint) {
    hintEl = document.createElement('p');
    hintEl.className = 'edit-hint';
    hintEl.hidden = true;
    wrapper.appendChild(hintEl);
  }

  const error = document.createElement('p');
  error.className = 'field-error';
  error.hidden = true;
  wrapper.appendChild(error);

  return { wrapper, input, hint: hintEl, error };
}

function createEditForm(request) {
  const form = document.createElement('form');
  form.className = 'request-edit';
  form.hidden = true;
  form.noValidate = true;

  const grid = document.createElement('div');
  grid.className = 'edit-grid';

  const fields = {
    title: createEditField(request, {
      name: 'title',
      label: 'Title',
      value: request.title,
      maxLength: LIMITS.title,
    }),
    url: createEditField(request, {
      name: 'url',
      label: 'URL',
      value: request.url,
      type: 'url',
      maxLength: LIMITS.url,
    }),
    quantity: createEditField(request, {
      name: 'quantity',
      label: 'Quantity',
      value: request.quantity,
      type: 'number',
      min: 1,
      max: LIMITS.quantity,
      step: 1,
    }),
    price: createEditField(request, {
      name: 'price',
      label: 'Price (optional, in euros)',
      value: hasPrice(request) ? Number(request.price).toFixed(2) : '',
      type: 'number',
      min: 0,
      max: LIMITS.price,
      step: '0.01',
      hint: true,
    }),
    note: createEditField(request, {
      name: 'note',
      label: 'Notes (optional)',
      value: request.note,
      multiline: true,
      maxLength: LIMITS.note,
    }),
  };

  for (const key of ['title', 'url', 'quantity', 'price', 'note']) {
    grid.appendChild(fields[key].wrapper);
  }
  form.appendChild(grid);

  function updatePriceHint() {
    if (!fields.price.hint) return;
    const text = formatEditPriceHint(fields.price.input.value);
    fields.price.hint.textContent = text;
    fields.price.hint.hidden = !text;
  }

  updatePriceHint();
  fields.price.input.addEventListener('input', updatePriceHint);

  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'button button-primary edit-save';
  saveButton.textContent = 'Save';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'button edit-cancel';
  cancelButton.textContent = 'Cancel';

  actions.appendChild(saveButton);
  actions.appendChild(cancelButton);
  form.appendChild(actions);

  function clearErrors() {
    for (const field of Object.values(fields)) {
      field.error.textContent = '';
      field.error.hidden = true;
      field.input.removeAttribute('aria-invalid');
    }
  }

  function setErrors(errors) {
    clearErrors();
    let firstInvalid = null;
    for (const [name, message] of Object.entries(errors || {})) {
      if (!fields[name]) continue;
      fields[name].error.textContent = message;
      fields[name].error.hidden = false;
      fields[name].input.setAttribute('aria-invalid', 'true');
      if (!firstInvalid) firstInvalid = fields[name].input;
    }
    if (firstInvalid) firstInvalid.focus();
  }

  return { form, fields, saveButton, cancelButton, clearErrors, setErrors };
}

function buildCard(request) {
  const card = document.createElement('article');
  card.className = 'request-card';
  card.dataset.id = request.id;
  card.dataset.status = request.status;

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

  if (hasPrice(request)) {
    const price = document.createElement('span');
    price.className = 'price';
    price.textContent = `Price ${BIFMList.formatPrice(request.price)}`;
    side.appendChild(price);
  }

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

  const edit = createEditForm(request);

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'button button-small edit-open';
  editButton.textContent = 'Edit';
  editButton.setAttribute('aria-label', `Edit ${request.title}`);

  editButton.addEventListener('click', () => {
    edit.clearErrors();
    main.hidden = true;
    side.hidden = true;
    edit.form.hidden = false;
    edit.fields.title.focus();
  });

  edit.cancelButton.addEventListener('click', () => {
    edit.clearErrors();
    edit.form.hidden = true;
    main.hidden = false;
    side.hidden = false;
    editButton.focus();
  });

  edit.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    edit.clearErrors();

    const result = validateEdit({
      title: edit.fields.title.input.value,
      url: edit.fields.url.input.value,
      note: edit.fields.note.input.value,
      quantity: edit.fields.quantity.input.value,
      price: edit.fields.price.input.value,
    });

    if (Object.keys(result.errors).length > 0) {
      edit.setErrors(result.errors);
      showBanner('Please fix the highlighted fields.', 'error');
      return;
    }

    edit.saveButton.disabled = true;
    edit.saveButton.textContent = 'Saving…';

    try {
      const response = await fetch(`/api/requests/${encodeURIComponent(request.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.value),
      });
      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        showLogin({ message: 'Your session expired. Log in again to change requests.' });
        return;
      }

      if (!response.ok) {
        if (data.details && typeof data.details === 'object') {
          edit.setErrors(data.details);
        }
        throw new Error(data.error || `Server returned ${response.status}.`);
      }

      hideBanner();
      await loadRequests({ silent: true });
    } catch (err) {
      showBanner(`Could not save changes: ${err.message}`, 'error');
    } finally {
      edit.saveButton.disabled = false;
      edit.saveButton.textContent = 'Save';
    }
  });

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'button button-small button-danger';
  deleteButton.textContent = 'Delete';
  deleteButton.setAttribute('aria-label', `Delete ${request.title}`);

  deleteButton.addEventListener('click', () => {
    if (deleteButton.disabled) return;
    askDelete({ id: request.id, title: request.title, button: deleteButton });
  });

  const cardActions = document.createElement('div');
  cardActions.className = 'card-actions';
  cardActions.appendChild(editButton);
  cardActions.appendChild(deleteButton);

  side.appendChild(cardActions);

  card.appendChild(main);
  card.appendChild(side);
  card.appendChild(edit.form);
  return card;
}

function updateFilterCounts() {
  const queryMatches = BIFMList.filterAndSortRequests(allRequests, {
    query: listState.query,
    status: 'all',
    sort: 'newest',
  });

  const counts = { all: queryMatches.length, New: 0, Purchased: 0, Done: 0, 'Not buying': 0 };
  for (const request of queryMatches) {
    if (Object.prototype.hasOwnProperty.call(counts, request.status)) {
      counts[request.status] += 1;
    }
  }

  for (const chip of chipButtons) {
    const status = chip.dataset.status;
    const countEl = chip.querySelector('.chip-count');
    if (!countEl) continue;
    countEl.textContent = String(status === 'all' ? counts.all : counts[status] || 0);
  }
}

function syncControls() {
  // Do not overwrite the field while the user is typing in it.
  if (document.activeElement !== searchInput) {
    searchInput.value = listState.query;
  }
  sortSelect.value = listState.sort;

  for (const chip of chipButtons) {
    chip.setAttribute('aria-pressed', String(chip.dataset.status === listState.status));
  }

  clearFiltersButton.hidden = !hasActiveFilters();
}

function render() {
  const visible = BIFMList.filterAndSortRequests(allRequests, listState);
  const hasAny = allRequests.length > 0;

  summaryEl.hidden = !hasAny;
  controlsEl.hidden = !hasAny;
  emptyEl.hidden = hasAny;
  emptyFilteredEl.hidden = !(hasAny && visible.length === 0);
  loadingEl.hidden = true;

  statTotalEl.textContent = String(allRequests.length);
  statOpenEl.textContent = String(
    allRequests.filter((request) => request.status === 'New').length
  );
  statPurchasedEl.textContent = String(
    allRequests.filter((request) => request.status === 'Purchased').length
  );

  updateFilterCounts();
  syncControls();

  listEl.replaceChildren();
  for (const request of visible) {
    listEl.appendChild(buildCard(request));
  }
}

async function loadRequests({ silent = false } = {}) {
  const revision = listRevision;
  if (!silent && allRequests.length === 0) {
    loadingEl.hidden = false;
  }
  if (!silent) refreshButton.disabled = true;

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

    // A delete finished while this request was in flight; its newer state wins.
    if (revision !== listRevision) return;

    hideBanner();
    const payload = JSON.stringify(data.requests);
    if (payload !== lastPayload) {
      allRequests = data.requests;
      lastPayload = payload;
      render();
    }
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

    if (!data.authenticated) {
      showLogin();
      return;
    }

    showApp();
    await loadRequests();
  } catch (err) {
    // Show the shell so the message is actionable; no data has been rendered.
    authRequired = true;
    showApp();
    loadingEl.hidden = true;
    showBanner(`Could not check login: ${err.message}`, 'error');
  }
}

async function init() {
  syncControls();
  await checkSession();
}

searchInput.addEventListener('input', () => {
  listState.query = searchInput.value;
  saveStoredState();
  render();
});

sortSelect.addEventListener('change', () => {
  listState.sort = SORT_VALUES.includes(sortSelect.value) ? sortSelect.value : 'newest';
  saveStoredState();
  render();
});

for (const chip of chipButtons) {
  chip.addEventListener('click', () => {
    if (listState.status === chip.dataset.status) return;
    listState.status = chip.dataset.status;
    saveStoredState();
    render();
  });
}

clearFiltersButton.addEventListener('click', () => {
  listState = { ...listState, query: '', status: 'all' };
  saveStoredState();
  searchInput.value = '';
  render();
  searchInput.focus();
});

loginForm.addEventListener('submit', handleLogin);
refreshButton.addEventListener('click', () => loadRequests());
logoutButton.addEventListener('click', handleLogout);

deleteCancelButton.addEventListener('click', closeDeleteDialog);

deleteDialog.addEventListener('close', () => {
  // Covers Escape and any other path that closes the dialog.
  pendingDelete = null;
});

deleteConfirmButton.addEventListener('click', () => {
  const target = pendingDelete;
  closeDeleteDialog();
  if (target) deleteRequest(target);
});

init();
