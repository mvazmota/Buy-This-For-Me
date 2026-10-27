'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { filterAndSortRequests, formatPrice } = require('../public/list-utils');

// Same options as public/list-utils.js; keeps the assertions locale-stable.
const EURO = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Input order mimics the API: newest first, with deliberate ties.
const REQUESTS = [
  {
    id: 'a',
    title: 'Milk',
    note: 'Semi-skimmed',
    url: 'https://shop.example/milk',
    quantity: 2,
    status: 'New',
    submittedAt: '2026-01-01T10:00:00.000Z',
  },
  {
    id: 'b',
    title: 'bread',
    note: '',
    url: 'https://bakery.example/loaf',
    quantity: 1,
    status: 'Purchased',
    submittedAt: '2026-01-02T10:00:00.000Z',
  },
  {
    id: 'c',
    title: 'Apples',
    note: 'Green apples',
    url: 'https://market.example/apples',
    quantity: 3,
    status: 'Done',
    submittedAt: '2026-01-03T10:00:00.000Z',
  },
  {
    id: 'd',
    title: 'Batteries',
    note: 'AA',
    url: 'https://tech.example/aa',
    quantity: 1,
    status: 'Not buying',
    submittedAt: '2026-01-04T10:00:00.000Z',
  },
  {
    id: 'e',
    title: 'apples',
    note: 'red',
    url: 'https://market.example/red',
    quantity: 3,
    status: 'New',
    submittedAt: '2026-01-05T10:00:00.000Z',
  },
];

function ids(items) {
  return items.map((item) => item.id);
}

test('defaults to newest first', () => {
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS)), ['e', 'd', 'c', 'b', 'a']);
});

test('sorts oldest first', () => {
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { sort: 'oldest' })), [
    'a',
    'b',
    'c',
    'd',
    'e',
  ]);
});

test('sorts title A-Z case-insensitively and keeps ties stable', () => {
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { sort: 'title' })), [
    'c',
    'e',
    'd',
    'b',
    'a',
  ]);
});

test('sorts quantity high to low and keeps ties stable', () => {
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { sort: 'quantity' })), [
    'c',
    'e',
    'a',
    'b',
    'd',
  ]);
});

test('sorts price high to low and puts requests without a price last', () => {
  const priced = [
    { id: 'none-a', price: null, submittedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'cheap', price: 4.5, submittedAt: '2026-02-02T00:00:00.000Z' },
    { id: 'expensive', price: 99.99, submittedAt: '2026-02-03T00:00:00.000Z' },
    { id: 'none-b', submittedAt: '2026-02-04T00:00:00.000Z' },
    { id: 'tie', price: 4.5, submittedAt: '2026-02-05T00:00:00.000Z' },
    { id: 'free', price: 0, submittedAt: '2026-02-06T00:00:00.000Z' },
  ];

  // Input order decides ties; unpriced rows keep that order after priced rows.
  assert.deepEqual(ids(filterAndSortRequests(priced, { sort: 'price' })), [
    'expensive',
    'cheap',
    'tie',
    'free',
    'none-a',
    'none-b',
  ]);
  assert.ok(
    filterAndSortRequests(priced, { sort: 'price' }).some((request) => request.id === 'free')
  );
});

test('sorts status in workflow order and keeps ties stable', () => {
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { sort: 'status' })), [
    'a',
    'e',
    'b',
    'c',
    'd',
  ]);
});

test('search matches title, note, and URL case-insensitively and trims', () => {
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { query: 'APPLES' })), ['e', 'c']);
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { query: '  green  ' })), ['c']);
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { query: 'bakery' })), ['b']);
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { query: 'AA' })), ['d']);
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { query: '  milk  ' })), ['a']);
});

test('status filter keeps only the requested status', () => {
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { status: 'New' })), ['e', 'a']);
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { status: 'Purchased' })), ['b']);
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { status: 'Not buying' })), ['d']);
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { status: 'all' })), [
    'e',
    'd',
    'c',
    'b',
    'a',
  ]);
  assert.deepEqual(filterAndSortRequests(REQUESTS, { status: 'Nope' }), []);
});

test('combines search, status, and sort options', () => {
  assert.deepEqual(
    ids(filterAndSortRequests(REQUESTS, { query: 'apples', status: 'New', sort: 'oldest' })),
    ['e']
  );
  assert.deepEqual(
    ids(filterAndSortRequests(REQUESTS, { query: 'market', status: 'Done', sort: 'title' })),
    ['c']
  );
});

test('returns an empty array when nothing matches', () => {
  assert.deepEqual(filterAndSortRequests(REQUESTS, { query: 'no-such-thing' }), []);
  assert.deepEqual(filterAndSortRequests([], { query: 'milk' }), []);
});

test('does not mutate the input array or its objects', () => {
  const before = ids(REQUESTS);
  const snapshot = JSON.stringify(REQUESTS);

  const sorted = filterAndSortRequests(REQUESTS, { sort: 'quantity' });
  const filtered = filterAndSortRequests(REQUESTS, { query: 'apples', sort: 'title' });

  assert.notEqual(sorted, REQUESTS);
  assert.notEqual(filtered, REQUESTS);
  assert.deepEqual(ids(REQUESTS), before);
  assert.equal(JSON.stringify(REQUESTS), snapshot);
});

test('handles unknown sorts, missing options, and non-array input', () => {
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS, { sort: 'sideways' })), [
    'e',
    'd',
    'c',
    'b',
    'a',
  ]);
  assert.deepEqual(ids(filterAndSortRequests(REQUESTS)), ['e', 'd', 'c', 'b', 'a']);
  assert.deepEqual(filterAndSortRequests(null), []);
  assert.deepEqual(filterAndSortRequests(undefined, undefined), []);
});

test('formatPrice shows euros with two decimals and hides missing prices', () => {
  const formatted = formatPrice(12.5);
  assert.equal(formatted, EURO.format(12.5));
  assert.equal(formatted.replace(/\u00a0/g, ' '), '12,50 €');
  assert.ok(formatted.includes('€'));
  assert.ok(formatted.includes('12,50'));

  assert.equal(formatPrice(59.95), EURO.format(59.95));
  assert.equal(formatPrice(0), EURO.format(0));

  assert.equal(formatPrice(null), '');
  assert.equal(formatPrice(undefined), '');
  assert.equal(formatPrice(''), '');
  assert.equal(formatPrice('not a price'), '');
});
