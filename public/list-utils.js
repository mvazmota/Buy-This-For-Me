/**
 * Pure list helpers shared by the dashboard (browser) and Node tests.
 *
 * No DOM access. public/index.html loads this file before app.js, and the
 * CommonJS export below lets test/dashboard.test.js require it directly.
 */
(function (global) {
  'use strict';

  const SORT_OPTIONS = ['newest', 'oldest', 'title', 'quantity', 'price', 'status'];

  // Workflow order, not alphabetical order.
  const STATUS_ORDER = ['New', 'Purchased', 'Done', 'Not buying'];

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  function timestamp(request) {
    const parsed = Date.parse(request.submittedAt);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function quantity(request) {
    const value = Number(request.quantity);
    return Number.isFinite(value) ? value : 0;
  }

  function statusRank(request) {
    const index = STATUS_ORDER.indexOf(request.status);
    return index === -1 ? STATUS_ORDER.length : index;
  }

  // Keep in sync with extension/price-extractor.js (the popup copy).
  const PRICE_FORMATTER = new Intl.NumberFormat('pt-PT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  /**
   * Format a stored plain number as a euro amount, e.g. 12.5 -> "12,50 €".
   * Missing or unusable values render as an empty string.
   */
  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return '';
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return PRICE_FORMATTER.format(number);
  }

  // Requests without a price sort after every priced request.
  function price(request) {
    if (request.price === null || request.price === undefined || request.price === '') {
      return -Infinity;
    }
    const value = Number(request.price);
    return Number.isFinite(value) ? value : -Infinity;
  }

  function matchesQuery(request, query) {
    if (!query) return true;
    return (
      normalizeText(request.title).includes(query) ||
      normalizeText(request.note).includes(query) ||
      normalizeText(request.url).includes(query)
    );
  }

  function compare(sort, left, right) {
    const a = left.request;
    const b = right.request;

    switch (sort) {
      case 'oldest':
        return timestamp(a) - timestamp(b) || left.index - right.index;
      case 'title': {
        const at = normalizeText(a.title);
        const bt = normalizeText(b.title);
        if (at !== bt) return at < bt ? -1 : 1;
        return left.index - right.index;
      }
      case 'quantity':
        return quantity(b) - quantity(a) || left.index - right.index;
      case 'price': {
        const ap = price(a);
        const bp = price(b);
        if (ap !== bp) return ap > bp ? -1 : 1;
        return left.index - right.index;
      }
      case 'status':
        return statusRank(a) - statusRank(b) || left.index - right.index;
      case 'newest':
      default:
        return timestamp(b) - timestamp(a) || left.index - right.index;
    }
  }

  /**
   * Filter and sort requests without mutating the input.
   *
   * @param {Array<object>} requests
   * @param {{query?: string, status?: string, sort?: string}} [options]
   *   status: 'all' (or empty) to keep every status.
   *   sort: one of SORT_OPTIONS; unknown values fall back to 'newest'.
   * @returns {Array<object>} a new array of the original request objects.
   */
  function filterAndSortRequests(requests, options) {
    const settings = options || {};
    const source = Array.isArray(requests)
      ? requests.filter((request) => request && typeof request === 'object')
      : [];

    const query = normalizeText(settings.query);
    const status = typeof settings.status === 'string' ? settings.status : 'all';
    const sort = SORT_OPTIONS.includes(settings.sort) ? settings.sort : 'newest';

    const statusFiltered =
      status && status !== 'all' ? source.filter((request) => request.status === status) : source;
    const queryFiltered = query
      ? statusFiltered.filter((request) => matchesQuery(request, query))
      : statusFiltered;

    return queryFiltered
      .map((request, index) => ({ request, index }))
      .sort((left, right) => compare(sort, left, right))
      .map((entry) => entry.request);
  }

  /**
   * Return a new array without the request that has the given id.
   *
   * Other items keep their relative order. An unknown id (or a non-array
   * input) is a no-op: the result still holds the same items in the same order.
   *
   * @param {Array<object>} requests
   * @param {string} id
   * @returns {Array<object>}
   */
  function removeRequestById(requests, id) {
    const source = Array.isArray(requests) ? requests : [];
    if (typeof id !== 'string' || !id) return source.slice();
    return source.filter(
      (request) => !(request && typeof request === 'object' && request.id === id)
    );
  }

  const api = { filterAndSortRequests, formatPrice, removeRequestById, SORT_OPTIONS, STATUS_ORDER };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.BIFMList = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
