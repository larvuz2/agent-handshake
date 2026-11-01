// Upgrades happen on a web page (never inside the agent), so card data never
// touches the agent. Three modes:
//   test     - a simulated checkout page, for local use and demos
//   stripe   - Stripe Checkout (subscription or one-time), confirmed on return and by webhook
//   external - redirect to the publisher's own checkoutUrl; they confirm via the admin API

import { createHmac } from 'node:crypto';
import { randomId, safeEqual, sign, verify } from '../util/crypto.js';
import { planById } from '../terms.js';

export class Checkout {
  constructor({ config, store, entitlements, services, log }) {
    Object.assign(this, { config, store, entitlements, services, log });
  }

  get mode() {
    return this.config.payments.mode;
  }

  /** @returns {Promise<string>} URL to send the person to */
  async start(entitlement, plan) {
    const service = this.services.get(entitlement.serviceId);
    const base = this.config.publicUrl;
    if (plan.checkoutUrl || this.mode === 'external') {
      if (!plan.checkoutUrl) throw new Error(`Plan ${plan.id} has no checkoutUrl (payments.mode is "external")`);
      const u = new URL(plan.checkoutUrl);
      u.searchParams.set('entitlement', entitlement.id);
      u.searchParams.set('plan', plan.id);
      u.searchParams.set('return_url', `${base}/my?upgraded=${service.id}`);
      return u.toString();
    }
    if (this.mode === 'test') {
      const ticket = sign(this.config.secret, { k: 'test-checkout', e: entitlement.id, p: plan.id }, 3600);
      return `${base}/checkout/test?ticket=${encodeURIComponent(ticket)}`;
    }
    return this.startStripe(entitlement, plan, service);
  }

  // ---------- test mode ----------

  readTestTicket(ticket) {
    const b = verify(this.config.secret, ticket);
    return b?.k === 'test-checkout' ? b : null;
  }

  completeTest(ticket) {
    const b = this.readTestTicket(ticket);
    if (!b) throw new Error('This test checkout link expired. Start the upgrade again.');
    const e = this.entitlements.get(b.e);
    const plan = planById(this.services.get(e.serviceId), b.p);
    this.recordPayment(e, plan, 'test', `test_${Date.now()}`);
    return this.entitlements.changePlan(e.id, plan.id, { billing: { provider: 'test' } });
  }

  // ---------- Stripe ----------

  async stripe(method, path, params) {
    const { secretKey, apiBase } = this.config.payments.stripe;
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': '2024-06-20',
      },
      body: params ? formEncode(params) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Stripe: ${data?.error?.message || res.status}`);
    return data;
  }

  async startStripe(e, plan, service) {
    const base = this.config.publicUrl;
    const recurring = Boolean(plan.price?.interval);
    const lineItem = plan.stripePriceId
      ? { price: plan.stripePriceId, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: (plan.price.currency || 'USD').toLowerCase(),
            unit_amount: Math.round(plan.price.amount * 100),
            product_data: { name: `${service.title} ${plan.title}` },
            ...(recurring ? { recurring: { interval: plan.price.interval } } : {}),
          },
        };
    const meta = { entitlement_id: e.id, plan_id: plan.id, service_id: service.id };
    const session = await this.stripe('POST', '/v1/checkout/sessions', {
      mode: recurring ? 'subscription' : 'payment',
      line_items: [lineItem],
      success_url: `${base}/checkout/stripe/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/my?canceled=${service.id}`,
      client_reference_id: e.id,
      metadata: meta,
      ...(recurring ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
    });
    return session.url;
  }

  // Called when Stripe sends the person back. Confirms with Stripe directly, so
  // upgrades work even before the webhook is set up.
  async completeStripe(sessionId) {
    const s = await this.stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
    return this.applyStripeSession(s);
  }

  applyStripeSession(s) {
    if (s.status !== 'complete' || !['paid', 'no_payment_required'].includes(s.payment_status)) return null;
    const e = this.entitlements.get(s.metadata?.entitlement_id || s.client_reference_id);
    if (!e) return null;
    const planId = s.metadata?.plan_id;
    if (e.planId === planId && e.billing?.stripeSession === s.id) return e; // already applied
    const plan = planById(this.services.get(e.serviceId), planId);
    if (!plan) return null;
    this.recordPayment(e, plan, 'stripe', s.id);
    return this.entitlements.changePlan(e.id, plan.id, {
      billing: { provider: 'stripe', stripeSession: s.id, stripeSubscription: s.subscription || null, stripeCustomer: s.customer || null },
    });
  }

  verifyStripeSignature(rawBody, header) {
    const secret = this.config.payments.stripe.webhookSecret;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
    const parts = Object.fromEntries(
      String(header || '')
        .split(',')
        .map((p) => p.split('='))
        .filter((p) => p.length === 2),
    );
    const sigs = String(header || '')
      .split(',')
      .filter((p) => p.startsWith('v1='))
      .map((p) => p.slice(3));
    const t = Number(parts.t);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) throw new Error('Stripe signature timestamp is too old');
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    if (!sigs.some((s) => safeEqual(s, expected))) throw new Error('Stripe signature does not match');
  }

  async webhook(rawBody, signature) {
    this.verifyStripeSignature(rawBody, signature);
    const event = JSON.parse(rawBody);
    const obj = event.data?.object || {};
    if (event.type === 'checkout.session.completed') {
      this.applyStripeSession(obj);
    } else if (event.type === 'customer.subscription.deleted') {
      const e = this.store.findOne('entitlements', (x) => x.billing?.stripeSubscription === obj.id);
      if (e && e.status !== 'dropped') {
        e.status = 'expired';
        e.expiresAt = Date.now();
        this.store.save();
      }
    }
    return { received: true, type: event.type };
  }

  async cancel(e) {
    if (e.billing?.provider === 'stripe' && e.billing.stripeSubscription && this.config.payments.stripe.secretKey) {
      try {
        await this.stripe('DELETE', `/v1/subscriptions/${encodeURIComponent(e.billing.stripeSubscription)}`);
      } catch (err) {
        this.log?.warn?.(`Could not cancel Stripe subscription for ${e.id}: ${err.message}`);
      }
    }
  }

  recordPayment(e, plan, provider, ref) {
    const id = randomId('pay_');
    this.store.put('payments', id, {
      id,
      entitlementId: e.id,
      serviceId: e.serviceId,
      userId: e.userId,
      planId: plan.id,
      amount: plan.price?.amount ?? 0,
      currency: plan.price?.currency ?? 'USD',
      provider,
      ref,
      createdAt: Date.now(),
    });
  }
}

// Stripe-style nested form encoding: a[b][0][c]=1
export function formEncode(obj) {
  const out = new URLSearchParams();
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.append(prefix, String(v));
  };
  walk('', obj);
  return out.toString();
}
