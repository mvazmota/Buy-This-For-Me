'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { RequestStore } = require('./store');
const { validateNewRequest, validateStatusUpdate } = require('./validate');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 64 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        const err = new Error('Request body is too large (limit 64 KB).');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        const err = new Error('Request body must be JSON.');
        err.statusCode = 400;
        reject(err);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Request body is not valid JSON.');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);

  // Prevent path traversal outside public/.
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    json(res, 404, { error: 'Not found.' });
    return;
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    json(res, 404, { error: 'Not found.' });
    return;
  }

  if (!stat.isFile()) {
    json(res, 404, { error: 'Not found.' });
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const type = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(resolved).pipe(res);
}

/**
 * Create the HTTP server. The caller decides host/port (always loopback).
 */
function createApp({ dataFile } = {}) {
  const resolvedDataFile = dataFile || path.join(__dirname, '..', 'data', 'requests.json');
  const store = new RequestStore(resolvedDataFile);

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '127.0.0.1';
    let pathname;
    try {
      pathname = new URL(req.url, `http://${host}`).pathname;
    } catch {
      json(res, 400, { error: 'Malformed request URL.' });
      return;
    }

    try {
      if (pathname === '/api/health') {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'Method not allowed. Use GET.' });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/requests') {
        if (req.method === 'GET') {
          const requests = store.list();
          json(res, 200, { requests });
          return;
        }

        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = validateNewRequest(body);
          if (!result.ok) {
            json(res, 400, {
              error: 'Please fix the highlighted fields.',
              details: result.errors,
            });
            return;
          }
          const request = await store.add(result.value);
          json(res, 201, { request });
          return;
        }

        json(res, 405, { error: 'Method not allowed. Use GET or POST.' });
        return;
      }

      const requestMatch = pathname.match(/^\/api\/requests\/([^/]+)$/);
      if (requestMatch) {
        const id = decodeURIComponent(requestMatch[1]);
        if (req.method !== 'PATCH') {
          json(res, 405, { error: 'Method not allowed. Use PATCH.' });
          return;
        }
        const body = await readJsonBody(req);
        const result = validateStatusUpdate(body);
        if (!result.ok) {
          json(res, 400, {
            error: 'Please fix the highlighted fields.',
            details: result.errors,
          });
          return;
        }
        const updated = await store.updateStatus(id, result.value);
        if (!updated) {
          json(res, 404, { error: 'Request not found.' });
          return;
        }
        json(res, 200, { request: updated });
        return;
      }

      if (pathname.startsWith('/api/')) {
        json(res, 404, { error: 'API route not found.' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: 'Method not allowed.' });
        return;
      }

      serveStatic(req, res, pathname);
    } catch (err) {
      if (err && err.statusCode) {
        json(res, err.statusCode, { error: err.message });
        return;
      }
      console.error('Unhandled server error:', err);
      json(res, 500, { error: 'Internal server error. Check the server console.' });
    }
  });

  return { server, store, dataFile: resolvedDataFile };
}

module.exports = { createApp, PUBLIC_DIR };
