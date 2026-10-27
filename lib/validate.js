'use strict';

const STATUSES = ['New', 'Purchased', 'Done', 'Not buying'];
const MAX_TITLE = 200;
const MAX_NOTE = 1000;
const MAX_URL = 2048;
const MAX_QUANTITY = 999;
const MAX_PRICE = 1000000;
const EDITABLE_FIELDS = ['title', 'url', 'note', 'quantity', 'price', 'status'];

function readTitle(raw, errors) {
  const title = typeof raw === 'string' ? raw.trim() : '';
  if (!title) {
    errors.title = 'Title is required.';
  } else if (title.length > MAX_TITLE) {
    errors.title = `Title must be ${MAX_TITLE} characters or fewer.`;
  }
  return title;
}

function readUrl(raw, errors) {
  const rawUrl = typeof raw === 'string' ? raw.trim() : '';
  if (!rawUrl) {
    errors.url = 'URL is required.';
  } else if (rawUrl.length > MAX_URL) {
    errors.url = `URL must be ${MAX_URL} characters or fewer.`;
  } else {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      errors.url = 'URL must be a valid http:// or https:// address.';
    }
  }
  return rawUrl;
}

function readNote(raw, errors) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    errors.note = 'Note must be text.';
    return '';
  }
  const note = raw.trim();
  if (note.length > MAX_NOTE) {
    errors.note = `Note must be ${MAX_NOTE} characters or fewer.`;
  }
  return note;
}

function readQuantity(raw, errors) {
  if (raw === undefined || raw === null) return 1;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    errors.quantity = 'Quantity must be a whole number.';
    return 1;
  }
  if (raw < 1 || raw > MAX_QUANTITY) {
    errors.quantity = `Quantity must be between 1 and ${MAX_QUANTITY}.`;
    return 1;
  }
  return raw;
}

/**
 * Read an optional price. null, undefined and '' all clear the price.
 * Returns the normalized number (2 decimals max) or null.
 */
function readPrice(raw, errors) {
  if (raw === undefined || raw === null || raw === '') return null;

  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.price = 'Price must be a number.';
    return null;
  }
  if (raw < 0 || raw > MAX_PRICE) {
    errors.price = `Price must be between 0 and ${MAX_PRICE}.`;
    return null;
  }
  if (Math.abs(raw * 100 - Math.round(raw * 100)) > 1e-6) {
    errors.price = 'Price can have at most 2 decimals.';
    return null;
  }
  return Math.round(raw * 100) / 100;
}

function readStatus(raw, errors) {
  if (typeof raw !== 'string' || !STATUSES.includes(raw)) {
    errors.status = `Status must be one of: ${STATUSES.join(', ')}.`;
    return null;
  }
  return raw;
}

function isPlainObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

/**
 * Validate and normalize a new shopping request payload.
 * Returns { ok: true, value } or { ok: false, errors: { field: message } }.
 */
function validateNewRequest(body) {
  const errors = {};

  if (!isPlainObject(body)) {
    return { ok: false, errors: { body: 'Request body must be a JSON object.' } };
  }

  const title = readTitle(body.title, errors);
  const url = readUrl(body.url, errors);
  const note = readNote(body.note, errors);
  const quantity = readQuantity(body.quantity, errors);
  const price = readPrice(body.price, errors);

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      title,
      url,
      note,
      quantity,
      price,
    },
  };
}

/**
 * Validate a status update payload.
 * Returns { ok: true, value: status } or { ok: false, errors }.
 */
function validateStatusUpdate(body) {
  if (!isPlainObject(body)) {
    return { ok: false, errors: { body: 'Request body must be a JSON object.' } };
  }
  const errors = {};
  const status = readStatus(body.status, errors);
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: status };
}

/**
 * Validate a partial request update for PATCH /api/requests/:id.
 * Accepts any subset of title, url, note, quantity, price and status, but at
 * least one field must be present. Field rules match POST /api/requests.
 * Returns { ok: true, value: { field: value } } or { ok: false, errors }.
 */
function validateRequestUpdate(body) {
  if (!isPlainObject(body)) {
    return { ok: false, errors: { body: 'Request body must be a JSON object.' } };
  }

  const present = EDITABLE_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field)
  );
  if (present.length === 0) {
    return {
      ok: false,
      errors: {
        body: `Provide at least one field to update: ${EDITABLE_FIELDS.join(', ')}.`,
      },
    };
  }

  const errors = {};
  const value = {};

  if (present.includes('title')) value.title = readTitle(body.title, errors);
  if (present.includes('url')) value.url = readUrl(body.url, errors);
  if (present.includes('note')) value.note = readNote(body.note, errors);
  if (present.includes('quantity')) value.quantity = readQuantity(body.quantity, errors);
  if (present.includes('price')) value.price = readPrice(body.price, errors);
  if (present.includes('status')) value.status = readStatus(body.status, errors);

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value };
}

module.exports = {
  STATUSES,
  MAX_TITLE,
  MAX_NOTE,
  MAX_URL,
  MAX_QUANTITY,
  MAX_PRICE,
  EDITABLE_FIELDS,
  validateNewRequest,
  validateStatusUpdate,
  validateRequestUpdate,
};
