'use strict';

const STATUSES = ['New', 'Purchased', 'Done', 'Not buying'];
const MAX_TITLE = 200;
const MAX_NOTE = 1000;
const MAX_URL = 2048;
const MAX_QUANTITY = 999;

/**
 * Validate and normalize a new shopping request payload.
 * Returns { ok: true, value } or { ok: false, errors: { field: message } }.
 */
function validateNewRequest(body) {
  const errors = {};

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: { body: 'Request body must be a JSON object.' } };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    errors.title = 'Title is required.';
  } else if (title.length > MAX_TITLE) {
    errors.title = `Title must be ${MAX_TITLE} characters or fewer.`;
  }

  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
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

  let note = '';
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') {
      errors.note = 'Note must be text.';
    } else {
      note = body.note.trim();
      if (note.length > MAX_NOTE) {
        errors.note = `Note must be ${MAX_NOTE} characters or fewer.`;
      }
    }
  }

  let quantity = 1;
  if (body.quantity !== undefined && body.quantity !== null) {
    if (typeof body.quantity !== 'number' || !Number.isInteger(body.quantity)) {
      errors.quantity = 'Quantity must be a whole number.';
    } else if (body.quantity < 1 || body.quantity > MAX_QUANTITY) {
      errors.quantity = `Quantity must be between 1 and ${MAX_QUANTITY}.`;
    } else {
      quantity = body.quantity;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      title,
      url: rawUrl,
      note,
      quantity,
    },
  };
}

/**
 * Validate a status update payload.
 * Returns { ok: true, value: status } or { ok: false, errors }.
 */
function validateStatusUpdate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: { body: 'Request body must be a JSON object.' } };
  }
  if (typeof body.status !== 'string' || !STATUSES.includes(body.status)) {
    return {
      ok: false,
      errors: { status: `Status must be one of: ${STATUSES.join(', ')}.` },
    };
  }
  return { ok: true, value: body.status };
}

module.exports = {
  STATUSES,
  MAX_TITLE,
  MAX_NOTE,
  MAX_URL,
  MAX_QUANTITY,
  validateNewRequest,
  validateStatusUpdate,
};
