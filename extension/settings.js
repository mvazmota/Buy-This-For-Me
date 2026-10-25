'use strict';

// Shared backend settings for the popup and options page.
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3000';
const BACKEND_STORAGE_KEY = 'backendUrl';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function isLocalBackend(urlValue) {
  try {
    return LOCAL_HOSTS.has(new URL(urlValue).hostname);
  } catch {
    return false;
  }
}

/**
 * Normalize a dashboard root URL. Returns the origin, e.g.
 * https://buy-this-for-me.example.workers.dev (no path, query or hash).
 * Throws an Error with a user-facing message when the URL is not usable.
 */
function normalizeBackendUrl(rawValue) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) {
    throw new Error('Enter the dashboard URL.');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Enter a full URL, for example http://127.0.0.1:3000.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The dashboard URL must start with http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Do not put a username or password in the URL.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Use the dashboard root URL without a query or #fragment.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Use the dashboard root URL, not a page or /api path.');
  }

  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (local) {
    if (parsed.protocol !== 'http:') {
      throw new Error('Use http:// for the local server.');
    }
    if (parsed.port !== '3000') {
      throw new Error(
        'The extension is allowed to call only port 3000 locally. Use http://127.0.0.1:3000.'
      );
    }
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('A remote dashboard must use https://.');
  }

  return parsed.origin;
}

async function getBackendUrl() {
  try {
    const stored = await chrome.storage.local.get(BACKEND_STORAGE_KEY);
    return normalizeBackendUrl(stored[BACKEND_STORAGE_KEY] || DEFAULT_BACKEND_URL);
  } catch {
    return DEFAULT_BACKEND_URL;
  }
}

async function setBackendUrl(value) {
  const normalized = normalizeBackendUrl(value);
  await chrome.storage.local.set({ [BACKEND_STORAGE_KEY]: normalized });
  return normalized;
}
