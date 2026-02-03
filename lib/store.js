const { v4: uuidv4 } = require('uuid');
const { EventEmitter } = require('events');
const { EXPIRY } = require('./config');

class RequestStore extends EventEmitter {
  constructor() {
    super();
    this.requests = new Map();
    // Cleanup expired requests every minute
    this._cleanupInterval = setInterval(() => this._cleanup(), 60_000);
  }

  create(type, payload) {
    const id = uuidv4();
    const entry = {
      id,
      type,
      payload,
      status: 'pending',
      response: null,
      createdAt: Date.now(),
      resolvedAt: null,
      _resolve: null,
      _reject: null,
      _promise: null,
    };

    entry._promise = new Promise((resolve, reject) => {
      entry._resolve = resolve;
      entry._reject = reject;
    });

    this.requests.set(id, entry);
    return id;
  }

  get(id) {
    return this.requests.get(id) || null;
  }

  async wait(id) {
    const entry = this.requests.get(id);
    if (!entry) throw new Error(`Request ${id} not found`);
    if (entry.status === 'resolved') return entry.response;

    // Wait indefinitely for response
    return entry._promise;
  }

  respond(id, decision) {
    const entry = this.requests.get(id);
    if (!entry) return false;
    if (entry.status === 'resolved') return false;

    entry.status = 'resolved';
    entry.response = decision;
    entry.resolvedAt = Date.now();
    if (entry._resolve) entry._resolve(decision);

    // Emit event so server can broadcast to WebSocket clients
    this.emit('resolved', this._serialize(entry));
    return true;
  }

  getPending() {
    const pending = [];
    for (const entry of this.requests.values()) {
      if (entry.status === 'pending') {
        pending.push(this._serialize(entry));
      }
    }
    return pending;
  }

  getAll() {
    const all = [];
    for (const entry of this.requests.values()) {
      all.push(this._serialize(entry));
    }
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  _serialize(entry) {
    return {
      id: entry.id,
      type: entry.type,
      payload: entry.payload,
      status: entry.status,
      response: entry.response,
      createdAt: entry.createdAt,
      resolvedAt: entry.resolvedAt,
    };
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, entry] of this.requests) {
      if (now - entry.createdAt > EXPIRY) {
        if (entry.status === 'pending') {
          this.respond(id, entry.type === 'permission'
            ? { decision: 'deny', reason: 'Expired' }
            : { answer: 'No response (expired)' });
        }
        this.requests.delete(id);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupInterval);
  }
}

module.exports = new RequestStore();
