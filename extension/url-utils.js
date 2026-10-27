/**
 * Link helpers shared by the extension popup and Node tests.
 *
 * This is the canonical implementation of "same normalized link" used for the
 * duplicate warning. It has no DOM access and also exports CommonJS so
 * test/extension.test.js can require it directly.
 */
(function (global) {
  'use strict';

  // Exact tracking parameter names (compared case-insensitively).
  const TRACKING_NAMES = new Set([
    'fbclid',
    'gclid',
    'dclid',
    'gclsrc',
    'msclkid',
    'yclid',
    'twclid',
    'ttclid',
    'igshid',
    'mc_cid',
    'mc_eid',
    'srsltid',
    'gbraid',
    'wbraid',
    'ref',
    'tag',
    '_ga',
    '_gl',
  ]);

  // Prefixes that mark a tracking parameter (for example utm_source, _ga_ABC, ref_src).
  const TRACKING_PREFIXES = ['utm_', 'ref_', '_ga', 'pk_', 'mtm_', 'hsa_'];

  function isTrackingParam(name) {
    const lower = String(name || '').toLowerCase();
    if (!lower) return false;
    if (TRACKING_NAMES.has(lower)) return true;
    return TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  /**
   * Normalize a product URL for duplicate comparison:
   * - lowercases the host (URL does this) and ignores the fragment
   * - drops tracking parameters
   * - strips trailing slashes from the path
   * - sorts the remaining query parameters so order does not matter
   * Returns '' for missing, malformed or non-http(s) URLs.
   */
  function normalizeUrl(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';

    const host = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : '';
    const pathname = parsed.pathname.replace(/\/+$/, '');

    const params = [];
    for (const [name, paramValue] of parsed.searchParams) {
      if (isTrackingParam(name)) continue;
      params.push([name, paramValue]);
    }
    params.sort((left, right) => {
      if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
      if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
      return 0;
    });

    const search = new URLSearchParams();
    for (const [name, paramValue] of params) {
      search.append(name, paramValue);
    }
    const query = search.toString();

    return `${parsed.protocol}//${host}${port}${pathname}${query ? `?${query}` : ''}`;
  }

  /**
   * Return the first existing request whose URL normalizes to the same link,
   * or null. `requests` is the API list payload.
   */
  function findDuplicateRequest(requests, url) {
    const target = normalizeUrl(url);
    if (!target || !Array.isArray(requests)) return null;
    return requests.find((request) => request && normalizeUrl(request.url) === target) || null;
  }

  const api = { normalizeUrl, findDuplicateRequest, isTrackingParam };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.BIFMUrl = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
