// JSON-file store. Single process, in-memory, written to disk atomically.
// Swap this module for Postgres/Redis to run more than one instance.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const COLLECTIONS = ['users', 'clients', 'codes', 'grants', 'tokens', 'entitlements', 'usage', 'calls', 'meta', 'payments'];
const MAX_CALLS_PER_ENTITLEMENT = 50;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = dir ? join(dir, 'data.json') : null;
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
    this.timer = null;
    if (this.file) {
      mkdirSync(dir, { recursive: true });
      if (existsSync(this.file)) {
        const loaded = JSON.parse(readFileSync(this.file, 'utf8'));
        for (const c of COLLECTIONS) this.data[c] = loaded[c] || {};
      }
    }
  }

  get(col, id) {
    return this.data[col][id] || null;
  }

  put(col, id, value) {
    this.data[col][id] = value;
    this.save();
    return value;
  }

  update(col, id, patch) {
    const cur = this.data[col][id];
    if (!cur) return null;
    Object.assign(cur, typeof patch === 'function' ? patch(cur) : patch);
    this.save();
    return cur;
  }

  delete(col, id) {
    delete this.data[col][id];
    this.save();
  }

  all(col) {
    return Object.values(this.data[col]);
  }

  find(col, pred) {
    return this.all(col).filter(pred);
  }

  findOne(col, pred) {
    return this.all(col).find(pred) || null;
  }

  // Recent calls, kept per entitlement as a small ring buffer.
  pushCall(entitlementId, call) {
    const list = (this.data.calls[entitlementId] ||= []);
    list.unshift(call);
    if (list.length > MAX_CALLS_PER_ENTITLEMENT) list.length = MAX_CALLS_PER_ENTITLEMENT;
    this.save();
  }

  recentCalls(entitlementId) {
    return this.data.calls[entitlementId] || [];
  }

  // Daily usage buckets: usage[entitlementId][YYYY-MM-DD] = {calls, ok, latencyMs, costUsd}
  addUsage(entitlementId, day, delta) {
    const days = (this.data.usage[entitlementId] ||= {});
    const b = (days[day] ||= { calls: 0, ok: 0, latencyMs: 0, costUsd: 0 });
    b.calls += delta.calls || 0;
    b.ok += delta.ok || 0;
    b.latencyMs += delta.latencyMs || 0;
    b.costUsd = round6(b.costUsd + (delta.costUsd || 0));
    this.save();
  }

  usageDays(entitlementId) {
    return this.data.usage[entitlementId] || {};
  }

  save() {
    if (!this.file) return;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 100);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  // Drop expired codes and tokens.
  gc(now = Date.now()) {
    for (const [id, c] of Object.entries(this.data.codes)) if (c.expiresAt < now) delete this.data.codes[id];
    for (const [id, t] of Object.entries(this.data.tokens)) if (t.expiresAt < now) delete this.data.tokens[id];
    this.save();
  }
}

export function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

export function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}
