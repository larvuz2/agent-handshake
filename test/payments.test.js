// Stripe Checkout, x402 pay-per-call, and the publisher API, against mock servers.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { connect, formFields, rpc, startStack, textOf } from './helpers.js';
import { formEncode } from '../src/billing/checkout.js';
import { toAtomic } from '../src/billing/x402.js';

function mockServer(handler) {
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const out = await handler(req, body);
    res.writeHead(out.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

describe('Stripe checkout', () => {
  let s;
  let stripe;
  const sessions = new Map();
  const deletes = [];
  before(async () => {
    stripe = await mockServer((req, body) => {
      assert.equal(req.headers.authorization, 'Bearer sk_test_123');
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        const p = new URLSearchParams(body);
        const id = `cs_test_${sessions.size + 1}`;
        sessions.set(id, {
          id,
          url: `https://checkout.stripe.test/${id}`,
          status: 'complete',
          payment_status: 'paid',
          subscription: 'sub_123',
          customer: 'cus_123',
          client_reference_id: p.get('client_reference_id'),
          metadata: { entitlement_id: p.get('metadata[entitlement_id]'), plan_id: p.get('metadata[plan_id]') },
          _form: Object.fromEntries(p),
        });
        return { body: sessions.get(id) };
      }
      const m = /^\/v1\/checkout\/sessions\/(.+)$/.exec(req.url);
      if (req.method === 'GET' && m) return { body: sessions.get(m[1]) };
      if (req.method === 'DELETE' && req.url === '/v1/subscriptions/sub_123') {
        deletes.push(req.url);
        return { body: { id: 'sub_123', status: 'canceled' } };
      }
      return { status: 404, body: { error: { message: 'not found' } } };
    });
    s = await startStack({
      paymentsMode: 'stripe',
      env: { STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_abc', STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}` },
    });
  });
  after(async () => {
    await s.close();
    stripe.close();
  });

  test('upgrade creates a subscription checkout and the return page activates it', async () => {
    const c = await connect(s.base, 'lumen-video');
    const e = s.gw.store.all('entitlements')[0];
    const page = await c.browser.get(`${s.base}/upgrade/${e.id}?plan=pro`);
    const html = await page.text();
    assert.match(html, /Stripe Checkout/);
    const go = await c.browser.post(`${s.base}/upgrade/${e.id}`, { ...formFields(html), plan: 'pro' });
    assert.equal(go.headers.get('location'), 'https://checkout.stripe.test/cs_test_1');
    const form = sessions.get('cs_test_1')._form;
    assert.equal(form.mode, 'subscription');
    assert.equal(form['line_items[0][price_data][unit_amount]'], '900');
    assert.equal(form['line_items[0][price_data][recurring][interval]'], 'month');
    const back = await c.browser.get(`${s.base}/checkout/stripe/return?session_id=cs_test_1`);
    assert.equal(back.headers.get('location'), '/checkout/done?service=lumen-video&plan=pro');
    assert.equal(e.planId, 'pro');
    assert.equal(e.billing.stripeSubscription, 'sub_123');
  });

  test('the return link works once, and Keep free cancels the subscription', async () => {
    const e = s.gw.store.all('entitlements')[0];
    const payments = s.gw.store.all('payments').length;
    const browser = new (await import('./helpers.js')).Browser();
    await browser.get(`${s.base}/checkout/stripe/return?session_id=cs_test_1`);
    assert.equal(s.gw.store.all('payments').length, payments, 'replaying the return URL must not apply it again');
    const owner = s.gw.store.get('users', e.userId);
    const b2 = new (await import('./helpers.js')).Browser();
    b2.cookies.set('ah_uid', encodeURIComponent(s.gw.users.sealUid(owner.id)));
    const my = await (await b2.get(`${s.base}/my`)).text();
    const r = await b2.post(`${s.base}/my/${e.id}/keep-free`, { csrf: formFields(my).csrf });
    assert.equal(r.status, 303);
    assert.equal(e.planId, 'free');
    assert.deepEqual(deletes, ['/v1/subscriptions/sub_123']);
    // A late "subscription deleted" webhook no longer touches the free plan.
    const payload = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_123' } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_abc').update(`${t}.${payload}`).digest('hex');
    await fetch(`${s.base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: payload });
    assert.equal(e.status, 'active');
    // Replaying the old return URL after the switch does not bring Pro back.
    await browser.get(`${s.base}/checkout/stripe/return?session_id=cs_test_1`);
    assert.equal(e.planId, 'free');
  });

  test('webhook: signature checked, subscription end expires the plan', async () => {
    // Back on a paid subscription first.
    const e = s.gw.store.all('entitlements')[0];
    s.gw.entitlements.changePlan(e.id, 'pro', { billing: { provider: 'stripe', stripeSubscription: 'sub_123' } });
    const payload = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_123' } } });
    const bad = await fetch(`${s.base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: payload });
    assert.equal(bad.status, 400);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_abc').update(`${t}.${payload}`).digest('hex');
    const ok = await fetch(`${s.base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: payload });
    assert.equal(ok.status, 200);
    assert.equal(e.status, 'expired');
  });
});

describe('x402 pay per call', () => {
  let s;
  let facilitator;
  const seen = [];
  before(async () => {
    facilitator = await mockServer((req, body) => {
      const b = JSON.parse(body);
      seen.push({ path: req.url, body: b });
      const good = b.paymentPayload?.payload?.signature === '0xgood';
      if (req.url === '/verify') return { body: good ? { isValid: true, payer: '0xPAYER' } : { isValid: false, invalidReason: 'invalid_signature', payer: '0xPAYER' } };
      if (req.url === '/settle') return { body: { success: true, payer: '0xPAYER', transaction: '0xTX', network: 'eip155:84532' } };
      return { status: 404, body: {} };
    });
    s = await startStack({
      env: { X402_FACILITATOR_URL: `http://127.0.0.1:${facilitator.address().port}` },
      mutate(raw) {
        raw.services[1].plans = [
          { id: 'payg', title: 'Pay per call', default: true, x402: { pricePerCall: '0.01', network: 'eip155:84532', payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' } },
        ];
      },
    });
  });
  after(async () => {
    await s.close();
    facilitator.close();
  });

  test('payment required -> pay -> verified, forwarded, settled', async () => {
    const c = await connect(s.base, 'quick-notes');
    assert.match(c.html, /\$0\.01 per call, paid by your agent/);
    const r1 = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'add_note', arguments: { text: 'paid note' } });
    assert.equal(r1.body.result.isError, true);
    const pr = r1.body.result.structuredContent;
    assert.equal(pr.x402Version, 2);
    assert.deepEqual(JSON.parse(r1.body.result.content[0].text), pr);
    const req = pr.accepts[0];
    assert.equal(req.amount, '10000');
    assert.equal(req.asset, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    assert.deepEqual(req.extra, { name: 'USDC', version: '2' });

    const payment = { x402Version: 2, resource: pr.resource, accepted: req, payload: { signature: '0xbad', authorization: {} } };
    const r2 = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'add_note', arguments: { text: 'x' }, _meta: { 'x402/payment': payment } });
    assert.match(r2.body.result.structuredContent.error, /invalid_signature/);

    payment.payload.signature = '0xgood';
    const r3 = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'add_note', arguments: { text: 'paid note' }, _meta: { 'x402/payment': payment } });
    assert.match(textOf(r3.body.result), /Saved note/);
    assert.deepEqual(r3.body.result._meta['x402/payment-response'], { success: true, transaction: '0xTX', network: 'eip155:84532', payer: '0xPAYER' });
    const e = s.gw.store.all('entitlements')[0];
    assert.equal(e.totals.spendUsd, 0.01);
    assert.deepEqual(
      seen.map((x) => x.path),
      ['/verify', '/verify', '/settle'],
    );
  });

  test('parallel paid calls can not pass the spend cap', async () => {
    const e = s.gw.store.all('entitlements')[0];
    e.limits.spendUsd = e.period.spendUsd + 0.03;
    const g = s.gw.store.all('grants')[0];
    const tok = s.gw.oauth.issueTokens(g, `${s.base}/mcp/quick-notes`);
    const pr = (await rpc(`${s.base}/mcp/quick-notes`, tok.access_token, 'tools/call', { name: 'list_notes', arguments: {} })).body.result.structuredContent;
    const payment = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: '0xgood', authorization: {} } };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => rpc(`${s.base}/mcp/quick-notes`, tok.access_token, 'tools/call', { name: 'list_notes', arguments: {}, _meta: { 'x402/payment': payment } })),
    );
    const paid = results.filter((r) => r.body.result?._meta?.['x402/payment-response']?.success).length;
    assert.equal(paid, 3);
    assert.ok(e.period.spendUsd <= e.limits.spendUsd + 1e-9);
  });

  test("the person's spend policy blocks calls over their limit", async () => {
    const e = s.gw.store.all('entitlements')[0];
    delete e.limits.spendUsd; // from the previous test
    s.gw.store.get('users', e.userId).spendPolicy = { perCallUsd: 0.005 };
    const g = s.gw.store.all('grants')[0];
    const tok = s.gw.oauth.issueTokens(g, `${s.base}/mcp/quick-notes`);
    const r = await rpc(`${s.base}/mcp/quick-notes`, tok.access_token, 'tools/call', { name: 'list_notes', arguments: {} });
    assert.equal(r.body.result.isError, true);
    assert.match(textOf(r.body.result), /per-call limit/);
  });

  test('atomic amounts', () => {
    assert.equal(toAtomic('0.01'), '10000');
    assert.equal(toAtomic('1'), '1000000');
    assert.equal(toAtomic('0.000001'), '1');
    assert.equal(toAtomic('2.5', 18), '2500000000000000000');
  });
});

describe('publisher API and dashboard', () => {
  let s;
  before(async () => (s = await startStack()));
  after(() => s.close());

  test('API needs the admin key and can activate a plan (external payments)', async () => {
    await connect(s.base, 'lumen-video');
    const key = s.gw.config.adminKey;
    const no = await fetch(`${s.base}/v1/entitlements`);
    assert.equal(no.status, 401);
    const list = await (await fetch(`${s.base}/v1/entitlements?service=lumen-video`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(list.entitlements.length, 1);
    const id = list.entitlements[0].id;
    const r = await fetch(`${s.base}/v1/entitlements/${id}/activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'pro', reference: 'order_42' }),
    });
    const e = await r.json();
    assert.equal(e.planId, 'pro');
    assert.equal(e.billing.reference, 'order_42');
    const del = await (await fetch(`${s.base}/v1/entitlements/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(del.status, 'dropped');
  });

  test('dashboard login', async () => {
    const page = await (await fetch(`${s.base}/admin`)).text();
    assert.match(page, /Publisher dashboard/);
    const bad = await fetch(`${s.base}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'key=nope' });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${s.base}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `key=${s.gw.config.adminKey}`,
    });
    assert.equal(ok.status, 303);
    const cookie = ok.headers.getSetCookie()[0].split(';')[0];
    const dash = await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text();
    assert.match(dash, /Installs/);
    assert.match(dash, /Lumen Video/);
  });

  test('form encoding for Stripe', () => {
    assert.equal(decodeURIComponent(formEncode({ a: [{ b: { c: 1 } }], d: 'x' })), 'a[0][b][c]=1&d=x');
  });
});
