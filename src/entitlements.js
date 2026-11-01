// Entitlements: what a user may do with a service right now.
// Separate from OAuth tokens, so limits change without re-authorizing.
//
// entitlement { id, userId, serviceId, planId, status, scopes, limits,
//   startedAt, expiresAt, period: {start, calls, spendUsd}, totals: {calls, spendUsd},
//   trialUsed, droppedAt, stripe? }
// status: trial | active | expired | dropped

import { randomId } from './util/crypto.js';
import { dayKey, round6 } from './store.js';
import { defaultPlan, freePlan, isTrial, planAllowsTool, planById } from './terms.js';

const DAY = 86400000;

export class Entitlements {
  constructor(store, services) {
    this.store = store;
    this.services = services;
  }

  service(id) {
    return this.services.get(id) || null;
  }

  get(id) {
    const e = this.store.get('entitlements', id);
    if (e) this.refresh(e);
    return e;
  }

  forUser(userId) {
    return this.store
      .find('entitlements', (e) => e.userId === userId)
      .map((e) => this.refresh(e))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  forService(serviceId) {
    return this.store.find('entitlements', (e) => e.serviceId === serviceId).map((e) => this.refresh(e));
  }

  current(userId, serviceId) {
    return this.forUser(userId).find((e) => e.serviceId === serviceId) || null;
  }

  // Called on consent. Starts the trial, resumes it, or reconnects a past install.
  connect(userId, serviceId, { ip, planId } = {}) {
    const service = this.service(serviceId);
    const existing = this.current(userId, serviceId);
    if (existing) {
      if (existing.status === 'dropped') {
        // Coming back: resume the plan they had if it hasn't run out.
        const stillValid = !existing.expiresAt || existing.expiresAt > Date.now();
        existing.status = stillValid ? (isTrial(planById(service, existing.planId) || {}) ? 'trial' : 'active') : 'expired';
        existing.droppedAt = null;
        this.store.save();
      }
      return { entitlement: this.refresh(existing), created: false };
    }

    const plan = (planId && planById(service, planId)) || defaultPlan(service);
    if (isTrial(plan) && ip && service.trialsPerIpPerDay > 0) {
      const since = Date.now() - DAY;
      const recent = this.store.find(
        'entitlements',
        (e) => e.serviceId === serviceId && e.ip === ip && e.startedAt > since && e.trialUsed,
      ).length;
      if (recent >= service.trialsPerIpPerDay) {
        const err = new Error('Too many free trials started from this network today. Try again tomorrow.');
        err.code = 'trial_rate_limited';
        throw err;
      }
    }
    const e = this.create(userId, service, plan, { ip });
    return { entitlement: e, created: true };
  }

  create(userId, service, plan, { ip, status } = {}) {
    const now = Date.now();
    const e = {
      id: randomId('ent_'),
      userId,
      serviceId: service.id,
      planId: plan.id,
      status: status || (isTrial(plan) ? 'trial' : 'active'),
      scopes: plan.scopes,
      limits: { ...plan.limits, ...(isTrial(plan) && plan.limits.spendUsd === undefined ? { spendUsd: 0 } : {}) },
      startedAt: now,
      expiresAt: plan.durationDays ? now + plan.durationDays * DAY : null,
      period: { start: now, calls: 0, spendUsd: 0 },
      totals: { calls: 0, spendUsd: 0 },
      trialUsed: isTrial(plan),
      ip: ip || null,
      droppedAt: null,
    };
    return this.store.put('entitlements', e.id, e);
  }

  // Move to another plan (after payment, "Keep free", or an admin grant).
  changePlan(id, planId, extra = {}) {
    const e = this.store.get('entitlements', id);
    const service = this.service(e.serviceId);
    const plan = planById(service, planId);
    if (!plan) throw new Error(`Unknown plan ${planId}`);
    const now = Date.now();
    Object.assign(e, {
      planId: plan.id,
      status: isTrial(plan) ? 'trial' : 'active',
      scopes: plan.scopes,
      limits: { ...plan.limits },
      expiresAt: plan.durationDays ? now + plan.durationDays * DAY : null,
      period: { start: now, calls: 0, spendUsd: 0 },
      droppedAt: null,
      ...extra,
    });
    this.store.save();
    return e;
  }

  extend(id, days) {
    const e = this.store.get('entitlements', id);
    const base = Math.max(Date.now(), e.expiresAt || Date.now());
    e.expiresAt = base + days * DAY;
    if (e.status === 'expired') {
      const plan = planById(this.service(e.serviceId), e.planId);
      e.status = plan && isTrial(plan) ? 'trial' : 'active';
    }
    this.store.save();
    return e;
  }

  drop(id) {
    const e = this.store.get('entitlements', id);
    if (!e) return null;
    e.status = 'dropped';
    e.droppedAt = Date.now();
    // Revoke every grant (and so every token) tied to this entitlement.
    for (const g of this.store.find('grants', (g) => g.entitlementId === id && !g.revokedAt)) {
      g.revokedAt = Date.now();
    }
    for (const [tid, t] of Object.entries(this.store.data.tokens)) {
      if (t.entitlementId === id) delete this.store.data.tokens[tid];
    }
    this.store.save();
    return e;
  }

  // Expire trials and roll usage periods. Mutates and returns the entitlement.
  refresh(e) {
    const now = Date.now();
    if ((e.status === 'trial' || e.status === 'active') && e.expiresAt && e.expiresAt <= now) {
      e.status = 'expired';
      this.store.save();
    }
    const period = e.limits?.period;
    if (period === 'day' || period === 'month') {
      const len = period === 'day' ? DAY : 30 * DAY;
      if (now - e.period.start >= len) {
        e.period = { start: now - ((now - e.period.start) % len), calls: 0, spendUsd: 0 };
        this.store.save();
      }
    }
    return e;
  }

  /**
   * Can this entitlement call this tool now? Returns {ok:true} or {ok:false, reason, ...}.
   * reason: expired | dropped | calls | scope | spend
   */
  check(e, toolName, { costUsd = 0 } = {}) {
    this.refresh(e);
    const service = this.service(e.serviceId);
    const plan = planById(service, e.planId) || defaultPlan(service);
    if (e.status === 'dropped') return { ok: false, reason: 'dropped' };
    if (e.status === 'expired') return { ok: false, reason: 'expired' };
    if (!planAllowsTool(service, { ...plan, scopes: e.scopes }, toolName)) return { ok: false, reason: 'scope' };
    if (e.limits.calls !== undefined && e.period.calls >= e.limits.calls) return { ok: false, reason: 'calls' };
    if (costUsd > 0 && e.limits.spendUsd !== undefined && round6(e.period.spendUsd + costUsd) > e.limits.spendUsd) {
      return { ok: false, reason: 'spend' };
    }
    return { ok: true, plan };
  }

  // Reserve a call before forwarding (so parallel calls can't overshoot the cap).
  reserve(e) {
    e.period.calls += 1;
    e.totals.calls += 1;
    this.store.save();
  }

  release(e) {
    e.period.calls = Math.max(0, e.period.calls - 1);
    e.totals.calls = Math.max(0, e.totals.calls - 1);
    this.store.save();
  }

  record(e, { tool, ok, latencyMs, costUsd = 0, client }) {
    if (costUsd) {
      e.period.spendUsd = round6(e.period.spendUsd + costUsd);
      e.totals.spendUsd = round6(e.totals.spendUsd + costUsd);
    }
    e.lastUsedAt = Date.now();
    this.store.addUsage(e.id, dayKey(), { calls: 1, ok: ok ? 1 : 0, latencyMs, costUsd });
    this.store.pushCall(e.id, { tool, ok, latencyMs, costUsd, at: Date.now(), client: client || null });
  }

  keepFree(id) {
    const e = this.store.get('entitlements', id);
    const free = freePlan(this.service(e.serviceId));
    if (!free) throw new Error('This service has no free plan');
    return this.changePlan(id, free.id);
  }
}

export function daysLeft(e, now = Date.now()) {
  if (!e.expiresAt) return null;
  return Math.max(0, Math.ceil((e.expiresAt - now) / DAY));
}
