// End-to-end: discover -> connect (OAuth) -> trial -> limits -> upgrade -> drop.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, connect, formFields, initSession, rpc, startStack, textOf } from './helpers.js';

describe('discovery', () => {
  let s;
  before(async () => (s = await startStack()));
  after(() => s.close());

  test('authorization server metadata has what MCP clients need', async () => {
    const m = await (await fetch(`${s.base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(m.issuer, s.base);
    assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
    assert.equal(m.client_id_metadata_document_supported, true);
    assert.ok(m.token_endpoint_auth_methods_supported.includes('none'));
    assert.equal(m.authorization_response_iss_parameter_supported, true);
    assert.ok(m.registration_endpoint && m.revocation_endpoint);
  });

  test('protected resource metadata per tool', async () => {
    const r = await fetch(`${s.base}/.well-known/oauth-protected-resource/mcp/lumen-video`);
    const m = await r.json();
    assert.equal(m.resource, `${s.base}/mcp/lumen-video`);
    assert.deepEqual(m.authorization_servers, [s.base]);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });

  test('401 points at the resource metadata', async () => {
    const r = await fetch(`${s.base}/mcp/lumen-video`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp\/lumen-video"/);
  });

  test('server card with terms extension', async () => {
    const r = await fetch(`${s.base}/mcp/lumen-video/server-card`);
    assert.equal(r.headers.get('content-type'), 'application/mcp-server-card+json');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.ok(r.headers.get('etag'));
    const card = await r.json();
    assert.equal(card.name, 'com.lumenvideo/mcp');
    assert.equal(card.remotes[0].type, 'streamable-http');
    assert.equal(card.remotes[0].url, `${s.base}/mcp/lumen-video`);
    const terms = card._meta['dev.handshake/terms'];
    assert.equal(terms.defaultPlan, 'trial');
    assert.equal(terms.plans.find((p) => p.id === 'trial').limits.spendUsd, 0);
    assert.ok(card.description.length <= 100);
    const again = await fetch(`${s.base}/mcp/lumen-video/server-card`, { headers: { 'if-none-match': r.headers.get('etag') } });
    assert.equal(again.status, 304);
  });

  test('AI catalog, llms.txt, button and badge', async () => {
    const cat = await (await fetch(`${s.base}/.well-known/ai-catalog.json`)).json();
    assert.equal(cat.specVersion, '1.0');
    assert.equal(cat.entries.length, 2);
    assert.equal(cat.entries[0].type, 'application/mcp-server-card+json');
    assert.match(cat.entries[0].identifier, /^urn:air:lumen\.example:mcp:lumen-video$/);
    const llms = await (await fetch(`${s.base}/llms.txt`)).text();
    assert.match(llms, /Lumen Video/);
    assert.match(await (await fetch(`${s.base}/button.js`)).text(), /data-service/);
    const badge = await fetch(`${s.base}/badge/lumen-video.svg`);
    assert.equal(badge.headers.get('content-type'), 'image/svg+xml');
  });

  test('install page lists agent apps and works as JSON', async () => {
    const html = await (await fetch(`${s.base}/add/lumen-video`)).text();
    for (const app of ['Claude', 'Cursor', 'VS Code', 'Goose', 'Claude Code']) assert.ok(html.includes(app), app);
    assert.match(html, /Free for 7 days/);
    assert.match(html, /Spend limit: \$0/);
    const info = await (await fetch(`${s.base}/add/lumen-video?format=json`)).json();
    assert.equal(info.mcpUrl, `${s.base}/mcp/lumen-video`);
    assert.ok(info.targets.find((t) => t.id === 'cursor').href.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?'));
  });
});

describe('trial flow (JSON upstream)', () => {
  let s;
  let c;
  let sid;
  before(async () => {
    s = await startStack();
    c = await connect(s.base, 'lumen-video');
    sid = await initSession(c.mcpUrl, c.tokens.access_token);
  });
  after(() => s.close());

  test('consent screen shows the three lines and the app', () => {
    assert.match(c.html, /Test Agent wants to add Lumen Video/);
    assert.match(c.html, /Start free trial/);
    assert.match(c.html, /Create and read your video projects · Render 480p previews/);
    assert.match(c.html, /Free for 7 days · up to 100 calls/);
    assert.equal(c.iss, s.base);
  });

  test('token response', () => {
    assert.equal(c.tokens.token_type, 'Bearer');
    assert.ok(c.tokens.refresh_token);
    assert.equal(c.tokens.scope, 'projects render:preview');
  });

  test('tools/list hides locked tools and adds handshake_status', async () => {
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list', {}, { sessionId: sid });
    const names = r.body.result.tools.map((t) => t.name);
    assert.deepEqual(names, ['list_projects', 'create_project', 'render_preview', 'handshake_status']);
  });

  test('tools work, the upstream sees who is calling, calls are metered', async () => {
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'create_project', arguments: { prompt: 'sunrise over a mountain lake' } }, { sessionId: sid });
    assert.match(textOf(r.body.result), /Created prj_001/);
    const r2 = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'list_projects', arguments: {} }, { sessionId: sid });
    assert.match(textOf(r2.body.result), /prj_001/);
    const e = s.gw.store.all('entitlements')[0];
    assert.equal(e.totals.calls, 2);
    assert.equal(e.period.calls, 2);
    assert.equal(s.gw.store.recentCalls(e.id).length, 2);
  });

  test('a Pro-only tool explains how to upgrade', async () => {
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'render_full', arguments: { projectId: 'prj_001' } }, { sessionId: sid });
    assert.equal(r.body.result.isError, true);
    assert.match(textOf(r.body.result), /"render_full" is part of Lumen Video Pro \(\$9\/mo\)/);
    assert.match(textOf(r.body.result), /\/upgrade\/ent_[^?]+\?plan=pro&t=/);
  });

  test('handshake_status reports plan and usage', async () => {
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'handshake_status', arguments: {} }, { sessionId: sid });
    const t = textOf(r.body.result);
    assert.match(t, /Lumen Video: Free trial/);
    assert.match(t, /7 days left/);
    assert.match(t, /2 of 100 calls used/);
    assert.match(t, /Manage or remove: http/);
  });

  test('the app that connected is remembered', () => {
    const g = s.gw.store.all('grants')[0];
    assert.equal(g.clientInfo.name, 'test-agent');
    assert.equal(g.protocolVersion, '2025-11-25');
  });

  test('My tools shows the tool with usage', async () => {
    const html = await (await c.browser.get(`${s.base}/my`)).text();
    assert.match(html, /Lumen Video/);
    assert.match(html, /2 of 100 calls/);
    assert.match(html, /Upgrade \$9\/mo/);
  });

  test('upgrade through test checkout unlocks Pro tools', async () => {
    // The agent's link signs the person in, even in a fresh browser.
    const status = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'handshake_status', arguments: {} }, { sessionId: sid });
    const link = /Upgrade to Pro \(\$9\/mo\): (\S+)/.exec(textOf(status.body.result))[1];
    const fresh = new Browser();
    const r1 = await fresh.get(link);
    assert.equal(r1.status, 302);
    const page = await fresh.get(new URL(r1.headers.get('location'), s.base).toString());
    const html = await page.text();
    assert.match(html, /Continue to payment/);
    const fields = formFields(html);
    const r2 = await fresh.post(new URL(link).origin + new URL(link).pathname, { ...fields, plan: 'pro' });
    assert.equal(r2.status, 303);
    const checkout = await fresh.get(new URL(r2.headers.get('location'), s.base).toString());
    const chtml = await checkout.text();
    assert.match(chtml, /Pay \$9\/mo \(simulated\)/);
    const done = await fresh.post(`${s.base}/checkout/test`, formFields(chtml));
    assert.equal(done.headers.get('location'), '/my?upgraded=lumen-video');

    const e = s.gw.store.all('entitlements')[0];
    assert.equal(e.planId, 'pro');
    assert.equal(e.status, 'active');
    const list = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list', {}, { sessionId: sid });
    assert.ok(list.body.result.tools.some((t) => t.name === 'render_full'));
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'render_full', arguments: { projectId: 'prj_001' } }, { sessionId: sid });
    assert.match(textOf(r.body.result), /Rendered the 4K video/);
    assert.equal(s.gw.store.all('payments').length, 1);
  });

  test('refresh tokens rotate', async () => {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.client_id });
    const r = await fetch(`${s.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const t = await r.json();
    assert.equal(r.status, 200);
    assert.notEqual(t.refresh_token, c.tokens.refresh_token);
    const again = await fetch(`${s.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.equal(again.status, 400);
    assert.equal((await again.json()).error, 'invalid_grant');
    c.tokens = t;
  });

  test('a token only works for its own tool', async () => {
    const r = await rpc(`${s.base}/mcp/quick-notes`, c.tokens.access_token, 'tools/list');
    assert.equal(r.status, 401);
  });

  test('Remove in My tools revokes access at once', async () => {
    const html = await (await c.browser.get(`${s.base}/my`)).text();
    const e = s.gw.store.all('entitlements')[0];
    const csrf = formFields(html).csrf;
    const r = await c.browser.post(`${s.base}/my/${e.id}/remove`, { csrf });
    assert.equal(r.status, 303);
    const call = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list');
    assert.equal(call.status, 401);
    const refresh = await fetch(`${s.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.client_id }),
    });
    assert.equal(refresh.status, 400);
    const my = await (await c.browser.get(`${s.base}/my`)).text();
    assert.match(my, /Removed/);
  });

  test('adding it again resumes the same plan, no second trial', async () => {
    const again = await connect(s.base, 'lumen-video', { browser: c.browser });
    assert.match(again.html, /Connect again/);
    const ents = s.gw.store.all('entitlements');
    assert.equal(ents.length, 1);
    assert.equal(ents[0].status, 'active');
  });
});

describe('limits', () => {
  let s;
  before(async () => {
    s = await startStack({
      mutate(raw) {
        raw.services[0].plans[0].limits.calls = 2;
      },
    });
  });
  after(() => s.close());

  test('call cap', async () => {
    const c = await connect(s.base, 'lumen-video');
    const t = c.tokens.access_token;
    for (let i = 0; i < 2; i++) {
      const r = await rpc(c.mcpUrl, t, 'tools/call', { name: 'list_projects', arguments: {} });
      assert.notEqual(r.body.result.isError, true);
    }
    const r = await rpc(c.mcpUrl, t, 'tools/call', { name: 'list_projects', arguments: {} });
    assert.equal(r.body.result.isError, true);
    assert.match(textOf(r.body.result), /All 2 calls in the Free trial plan/);
    assert.match(textOf(r.body.result), /Switch to the Free plan \(no charge\)/);
    // handshake_status still works and doesn't count
    const st = await rpc(c.mcpUrl, t, 'tools/call', { name: 'handshake_status', arguments: {} });
    assert.match(textOf(st.body.result), /2 of 2 calls used/);
  });

  test('trial expiry, then Keep free', async () => {
    const c = await connect(s.base, 'lumen-video');
    const e = s.gw.store.find('entitlements', (x) => x.userId === s.gw.users.uidFromRequest({ headers: { cookie: c.browser.cookieHeader() } }))[0];
    e.expiresAt = Date.now() - 1000;
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'list_projects', arguments: {} });
    assert.equal(r.body.result.isError, true);
    assert.match(textOf(r.body.result), /free trial for Lumen Video ended/i);
    const html = await (await c.browser.get(`${s.base}/my`)).text();
    assert.match(html, /Ended/);
    const kept = await c.browser.post(`${s.base}/my/${e.id}/keep-free`, { csrf: formFields(html).csrf });
    assert.equal(kept.status, 303);
    assert.equal(e.planId, 'free');
    const ok = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'list_projects', arguments: {} });
    assert.notEqual(ok.body.result.isError, true);
    const locked = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'render_preview', arguments: { projectId: 'x' } });
    assert.equal(locked.body.result.isError, true);
  });

  test('upstream down: clear error, call not counted', async () => {
    const c = await connect(s.base, 'quick-notes');
    const e = s.gw.store.all('entitlements').find((x) => x.serviceId === 'quick-notes');
    const svc = s.gw.services.get('quick-notes');
    const saved = svc.upstream.url;
    svc.upstream.url = 'http://127.0.0.1:9/notes/mcp';
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'list_notes', arguments: {} });
    svc.upstream.url = saved;
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /not reachable/);
    assert.equal(e.period.calls, 0);
  });
});

describe('SSE upstream', () => {
  let s;
  before(async () => (s = await startStack({ sse: true })));
  after(() => s.close());

  test('tools/list is filtered and tools/call is metered through a stream', async () => {
    const c = await connect(s.base, 'lumen-video');
    const sid = await initSession(c.mcpUrl, c.tokens.access_token);
    const list = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list', {}, { sessionId: sid });
    assert.equal(list.headers.get('content-type'), 'text/event-stream');
    const names = list.body.result.tools.map((t) => t.name);
    assert.ok(!names.includes('render_full'));
    assert.ok(names.includes('handshake_status'));
    const call = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'create_project', arguments: { prompt: 'city at night' } }, { sessionId: sid });
    assert.match(textOf(call.body.result), /Created/);
    assert.equal(s.gw.store.all('entitlements')[0].totals.calls, 1);
  });
});

describe('MCP 2026-07-28 (stateless) and URL elicitation', () => {
  let s;
  before(async () => {
    s = await startStack({
      mutate(raw) {
        raw.services[0].plans[0].limits.calls = 1;
      },
    });
  });
  after(() => s.close());

  const meta = (caps = {}) => ({
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': caps,
    'io.modelcontextprotocol/clientInfo': { name: 'modern-agent', version: '2.0.0' },
  });

  test('stateless calls work and local results carry resultType', async () => {
    const c = await connect(s.base, 'lumen-video');
    const t = c.tokens.access_token;
    const list = await rpc(c.mcpUrl, t, 'tools/list', { _meta: meta() }, { headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' } });
    assert.equal(list.body.result.resultType, 'complete');
    assert.equal(list.body.result.cacheScope, 'private');
    assert.ok(list.body.result.ttlMs <= 300000);
    const st = await rpc(c.mcpUrl, t, 'tools/call', { name: 'handshake_status', arguments: {}, _meta: meta() });
    assert.equal(st.body.result.resultType, 'complete');
    assert.equal(s.gw.store.all('grants')[0].clientInfo.name, 'modern-agent');
  });

  test('over the limit with URL elicitation support: input_required, then decline', async () => {
    const c = await connect(s.base, 'lumen-video');
    const t = c.tokens.access_token;
    const caps = { elicitation: { form: {}, url: {} } };
    await rpc(c.mcpUrl, t, 'tools/call', { name: 'list_projects', arguments: {}, _meta: meta(caps) });
    const r = await rpc(c.mcpUrl, t, 'tools/call', { name: 'list_projects', arguments: {}, _meta: meta(caps) });
    assert.equal(r.body.result.resultType, 'input_required');
    const req = r.body.result.inputRequests.upgrade;
    assert.equal(req.method, 'elicitation/create');
    assert.equal(req.params.mode, 'url');
    assert.match(req.params.url, /\/upgrade\/ent_/);
    assert.ok(r.body.result.requestState.startsWith('ahs.'));
    const retry = await rpc(c.mcpUrl, t, 'tools/call', {
      name: 'list_projects',
      arguments: {},
      _meta: meta(caps),
      inputResponses: { upgrade: { action: 'decline' } },
      requestState: r.body.result.requestState,
    });
    assert.equal(retry.body.result.isError, true);
    assert.equal(retry.body.result.resultType, 'complete');
  });

  test('older clients with URL elicitation get the -32042 error', async () => {
    const c = await connect(s.base, 'lumen-video');
    const t = c.tokens.access_token;
    const sid = await initSession(c.mcpUrl, t, { elicitation: { url: {} } });
    await rpc(c.mcpUrl, t, 'tools/call', { name: 'list_projects', arguments: {} }, { sessionId: sid });
    const r = await rpc(c.mcpUrl, t, 'tools/call', { name: 'list_projects', arguments: {} }, { sessionId: sid });
    assert.equal(r.body.error.code, -32042);
    assert.equal(r.body.error.data.elicitations[0].mode, 'url');
  });
});
