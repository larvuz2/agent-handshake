// Regression tests for the security review (v0.1).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, connect, formFields, initSession, rpc, startStack, textOf } from './helpers.js';
import { clientIp } from '../src/util/http.js';

function uidOf(gw, browser) {
  return gw.users.uidFromRequest({ headers: { cookie: browser.cookieHeader() } });
}

describe('plan changes can not reset limits', () => {
  let s;
  before(async () => {
    s = await startStack({
      mutate(raw) {
        raw.services[0].plans[0].limits.calls = 2;
      },
    });
  });
  after(() => s.close());

  test('no second trial, no "switching" to the plan you are on', async () => {
    const c = await connect(s.base, 'lumen-video');
    const e = s.gw.store.find('entitlements', (x) => x.userId === uidOf(s.gw, c.browser))[0];
    e.expiresAt = Date.now() - 1000;
    s.gw.entitlements.refresh(e);
    const page = await (await c.browser.get(`${s.base}/upgrade/${e.id}`)).text();
    const csrf = formFields(page).csrf;
    const trial = await c.browser.post(`${s.base}/upgrade/${e.id}`, { csrf, plan: 'trial' });
    assert.equal(trial.status, 400);
    assert.equal(e.status, 'expired');

    const kept = await c.browser.post(`${s.base}/my/${e.id}/keep-free`, { csrf: formFields(await (await c.browser.get(`${s.base}/my`)).text()).csrf });
    assert.equal(kept.status, 303);
    assert.equal(e.planId, 'free');
    e.period.calls = 20;
    const again = await c.browser.post(`${s.base}/my/${e.id}/keep-free`, { csrf: formFields(await (await c.browser.get(`${s.base}/my`)).text()).csrf });
    assert.equal(again.status, 303);
    assert.equal(e.period.calls, 20, 'Keep free on the free plan must not reset its calls');
    const same = await c.browser.post(`${s.base}/upgrade/${e.id}`, { csrf, plan: 'free' });
    assert.equal(same.status, 400);
  });

  test('a publisher revoke sticks: reconnecting is refused', async () => {
    const c = await connect(s.base, 'quick-notes');
    const e = s.gw.store.find('entitlements', (x) => x.serviceId === 'quick-notes')[0];
    const r = await fetch(`${s.base}/v1/entitlements/${e.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${s.gw.config.adminKey}` } });
    assert.equal(r.status, 200);
    await assert.rejects(connect(s.base, 'quick-notes', { browser: c.browser }), /no redirect after consent \(403\)/);
  });
});

describe('MCP request hygiene', () => {
  let s;
  let c;
  before(async () => {
    s = await startStack();
    c = await connect(s.base, 'lumen-video');
  });
  after(() => s.close());

  const post = (body) =>
    fetch(c.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${c.tokens.access_token}` },
      body: JSON.stringify(body),
    });

  test('object ids and duplicate ids are refused, so results always match their call', async () => {
    const obj = await post({ jsonrpc: '2.0', id: { x: 1 }, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
    assert.equal(obj.status, 400);
    const dup = await post([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: {} } },
    ]);
    assert.equal(dup.status, 400);
    const e = s.gw.store.all('entitlements')[0];
    assert.equal(e.totals.calls, 0);
  });

  test('a non-ASCII app name does not break the connection', async () => {
    const sid = await initSession(c.mcpUrl, c.tokens.access_token);
    await rpc(c.mcpUrl, c.tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Claude ✨', version: '1' } });
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'list_projects', arguments: {} }, { sessionId: sid });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.result.isError, true);
  });

  test('after a plan ends, only listing and the upgrade message work', async () => {
    const e = s.gw.store.all('entitlements')[0];
    e.expiresAt = Date.now() - 1000;
    const read = await rpc(c.mcpUrl, c.tokens.access_token, 'resources/read', { uri: 'lumen://x' });
    assert.equal(read.body.error.code, -32001);
    const list = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list');
    assert.ok(list.body.result.tools.length > 0);
    const call = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'list_projects', arguments: {} });
    assert.match(textOf(call.body.result), /ended/);
  });
});

describe('sign-in links', () => {
  let s;
  before(async () => (s = await startStack()));
  after(() => s.close());

  test('opening a My tools link asks first, and warns before switching lists', async () => {
    const attacker = await connect(s.base, 'quick-notes');
    const status = await rpc(attacker.mcpUrl, attacker.tokens.access_token, 'tools/call', { name: 'handshake_status', arguments: {} });
    const link = /Manage or remove: (\S+)/.exec(textOf(status.body.result))[1];

    const victim = await connect(s.base, 'lumen-video');
    const before = victim.browser.cookieHeader();
    const page = await victim.browser.get(link);
    assert.equal(page.status, 200);
    assert.equal(victim.browser.cookieHeader(), before, 'opening the link must not change the session');
    const html = await page.text();
    assert.match(html, /already has a different list of tools/);
    const ok = await victim.browser.post(`${s.base}/my/login`, formFields(html));
    assert.equal(ok.status, 303);
    assert.notEqual(victim.browser.cookieHeader(), before);
  });

  test('admin sessions end when the admin key changes', async () => {
    const r = await fetch(`${s.base}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `key=${s.gw.config.adminKey}`,
    });
    const cookie = r.headers.getSetCookie()[0].split(';')[0];
    assert.match(await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text(), /Installs/);
    const old = s.gw.config.adminKey;
    s.gw.config.adminKey = 'ahk_rotated';
    assert.match(await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text(), /Sign in with the admin key/);
    s.gw.config.adminKey = old;
  });
});

describe('client registration limits', () => {
  let s;
  before(async () => (s = await startStack()));
  after(() => s.close());

  const register = (body) => fetch(`${s.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('size limits', async () => {
    assert.equal((await register({ redirect_uris: Array.from({ length: 9 }, (_, i) => `https://a.example/${i}`) })).status, 400);
    assert.equal((await register({ redirect_uris: [`https://a.example/${'x'.repeat(600)}`] })).status, 400);
    assert.equal((await register({ redirect_uris: ['https://a.example/cb'], software_id: 'x'.repeat(20000) })).status, 413);
    const ok = await (await register({ redirect_uris: ['https://a.example/cb'], software_id: 'y'.repeat(500) })).json();
    assert.equal(ok.software_id, undefined);
  });

  test('unused clients are cleaned up after a week', async () => {
    const ok = await (await register({ redirect_uris: ['https://a.example/cb'] })).json();
    s.gw.store.get('clients', ok.client_id).createdAt = Date.now() - 8 * 86400000;
    s.gw.store.gc();
    assert.equal(s.gw.store.get('clients', ok.client_id), null);
  });
});

describe('client IP', () => {
  const req = (xff, extra = {}) => ({ headers: { 'x-forwarded-for': xff, ...extra }, socket: { remoteAddress: '10.0.0.9' } });
  test('proxy headers are only trusted when configured', () => {
    const saved = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    assert.equal(clientIp(req('1.2.3.4')), '10.0.0.9');
    process.env.TRUST_PROXY = 'true';
    assert.equal(clientIp(req('6.6.6.6, 1.2.3.4')), '1.2.3.4');
    process.env.TRUST_PROXY = 'fly-client-ip';
    assert.equal(clientIp(req('6.6.6.6', { 'fly-client-ip': '5.5.5.5' })), '5.5.5.5');
    if (saved === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved;
  });
});

describe('Browser helper sanity', () => {
  test('cookies', () => assert.equal(new Browser().cookieHeader(), ''));
});
