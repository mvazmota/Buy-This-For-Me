'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Tiny JSON-file store. Requests are kept newest-first, written atomically,
 * and all writes are serialized so concurrent updates cannot interleave.
 */
class RequestStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.requests = [];
    this.writeQueue = Promise.resolve();
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      return;
    }

    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read data file ${this.filePath}: ${err.message}`);
    }

    if (raw.trim() === '') {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Data file ${this.filePath} is not valid JSON (${err.message}). ` +
          'Fix or move the file before starting the server; it was left untouched.'
      );
    }

    if (!parsed || !Array.isArray(parsed.requests)) {
      throw new Error(
        `Data file ${this.filePath} has an unexpected shape (expected {"requests": [...]}). ` +
          'It was left untouched.'
      );
    }

    this.requests = parsed.requests;
  }

  list() {
    return this.requests.map((request) => ({ ...request }));
  }

  get(id) {
    const found = this.requests.find((request) => request.id === id);
    return found ? { ...found } : null;
  }

  add({ title, url, note, quantity }) {
    return this.enqueue(async () => {
      const now = new Date().toISOString();
      const request = {
        id: crypto.randomUUID(),
        title,
        url,
        note,
        quantity,
        status: 'New',
        submittedAt: now,
        updatedAt: now,
      };
      this.requests.unshift(request);
      await this.persist();
      return { ...request };
    });
  }

  updateStatus(id, status) {
    return this.enqueue(async () => {
      const index = this.requests.findIndex((request) => request.id === id);
      if (index === -1) {
        return null;
      }
      const updated = {
        ...this.requests[index],
        status,
        updatedAt: new Date().toISOString(),
      };
      this.requests[index] = updated;
      await this.persist();
      return { ...updated };
    });
  }

  enqueue(task) {
    const run = this.writeQueue.then(task, task);
    // Keep the queue alive even if a task fails.
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async persist() {
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify({ version: 1, requests: this.requests }, null, 2) + '\n';
    await fs.promises.writeFile(tmpPath, payload, 'utf8');
    await fs.promises.rename(tmpPath, this.filePath);
  }
}

module.exports = { RequestStore };
