// The hub: one MCP connection, every tool. Agents find, add and use tools themselves.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, connect, formFields, initSession, rpc, startStack, textOf } from './helpers.js';

const call = (c, name, args = {}, opts) => rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name, arguments: args }, opts);
const names = (r) => r.body.result.tools.map((t) => t.name);

describe('hub for agents', () => {
  let s;
  let c;
  let sid;
  before(async () => {
    s = await startStack();
    c = await connect(s.base, null, { form: { auto: '1' } });
    sid = await initSession(c.mcpUrl, c.tokens.access_token);
  });
  after(() => s.close());

  test('discovery points agents at the hub', async () => {
    const prm = await (await fetch(`${s.base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.resource, `${s.base}/mcp`);
    const card = await (await fetch(`${s.base}/mcp/server-card`)).json();
    assert.equal(card.remotes[0].url, `${s.base}/mcp`);
    assert.equal(card._meta['dev.handshake/hub'].tools.length, 5);
    const llms = await (await fetch(`${s.base}/llms.txt`)).text();
    assert.match(llms, /If you are an AI agent/);
    assert.match(llms, /handshake_search/);
    const agents = await (await fetch(`${s.base}/agents`)).text();
    assert.match(agents, /For AI agents/);
  });

  test('the person approves the hub once; the token is for the hub only', () => {
    assert.match(c.html, /Test Agent wants to connect to Agent Handshake/);
    assert.match(c.html, /Let my agent start free trials without asking me/);
    const grant = s.gw.store.all('grants')[0];
    assert.equal(grant.serviceId, '_hub');
    assert.equal(grant.entitlementId, null);
  });

  test('initialize and the agent tools', async () => {
    const init = await rpc(c.mcpUrl, c.tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } });
    assert.equal(init.body.result.serverInfo.name, 'agent-handshake-hub');
    assert.equal(init.body.result.capabilities.tools.listChanged, true);
    assert.match(init.body.result.instructions, /handshake_search/);
    const list = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list', {}, { sessionId: sid });
    assert.deepEqual(names(list), ['handshake_search', 'handshake_add', 'handshake_call', 'handshake_tool_info', 'handshake_my_tools', 'handshake_upgrade', 'handshake_remove']);
  });

  test('search finds tools by need', async () => {
    const r = await call(c, 'handshake_search', { query: 'make a video' });
    assert.equal(r.body.result.structuredContent.tools[0].id, 'lumen-video');
    assert.match(textOf(r.body.result), /Lumen Video \(lumen-video\)/);
    const time = await call(c, 'handshake_search', { query: 'what time is it in tokyo' });
    assert.equal(time.body.result.structuredContent.tools[0].id, 'world-clock');
    const all = await call(c, 'handshake_search', {});
    assert.equal(all.body.result.structuredContent.tools.length, 5);
  });

  test('add starts the free trial on its own and tells clients the list changed', async () => {
    const res = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'handshake_add', arguments: { tool: 'lumen-video' } }, { sessionId: sid, raw: true });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const body = await res.text();
    assert.match(body, /notifications\/tools\/list_changed/);
    assert.match(body, /Added Lumen Video: Free for 7 days/);
    const e = s.gw.store.all('entitlements').find((x) => x.serviceId === 'lumen-video');
    assert.equal(e.status, 'trial');
  });

  test('added tools appear as tool__action, limited to the plan', async () => {
    const list = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list', {}, { sessionId: sid });
    const n = names(list);
    assert.ok(n.includes('lumen-video__create_project'));
    assert.ok(n.includes('lumen-video__render_preview'));
    assert.ok(!n.includes('lumen-video__render_full'), 'Pro-only action stays hidden on the trial');
    assert.ok(!n.some((x) => x.startsWith('quick-notes__')), 'tools not added stay out');
  });

  test('calls go through the plan checks and are metered', async () => {
    const r = await call(c, 'lumen-video__create_project', { prompt: 'a red fox in fresh snow' }, { sessionId: sid });
    assert.match(textOf(r.body.result), /Created prj_001/);
    const via = await call(c, 'handshake_call', { tool: 'lumen-video', action: 'list_projects', arguments: {} });
    assert.match(textOf(via.body.result), /prj_001/);
    const locked = await call(c, 'lumen-video__render_full', { projectId: 'prj_001' });
    assert.equal(locked.body.result.isError, true);
    assert.match(textOf(locked.body.result), /part of Lumen Video Pro/);
    const e = s.gw.store.all('entitlements').find((x) => x.serviceId === 'lumen-video');
    assert.equal(e.totals.calls, 2);
  });

  test('a tool that is not added explains how to add it', async () => {
    const r = await call(c, 'handshake_call', { tool: 'quick-notes', action: 'list_notes' });
    assert.equal(r.body.result.isError, true);
    assert.match(textOf(r.body.result), /isn't added yet/);
  });

  test('my tools, tool info, upgrade link', async () => {
    const mine = await call(c, 'handshake_my_tools');
    assert.match(textOf(mine.body.result), /Lumen Video \(lumen-video\): Free trial/);
    assert.match(textOf(mine.body.result), /\/my\/login\?t=/);
    const info = await call(c, 'handshake_tool_info', { tool: 'lumen-video' });
    assert.match(textOf(info.body.result), /Input schemas/);
    const up = await call(c, 'handshake_upgrade', { tool: 'lumen-video' });
    assert.match(textOf(up.body.result), /Pro \(\$9\/mo\): http.*\/upgrade\/ent_.*plan=pro&t=/);
  });

  test('remove ends access', async () => {
    const r = await call(c, 'handshake_remove', { tool: 'lumen-video' });
    assert.match(textOf(r.body.result), /Removed Lumen Video/);
    const list = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list');
    assert.ok(!names(list).some((x) => x.startsWith('lumen-video__')));
    const after = await call(c, 'lumen-video__list_projects');
    assert.match(textOf(after.body.result), /isn't added yet/);
  });

  test('stateless (2026-07-28) clients work too', async () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'modern', version: '1' } };
    const list = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list', { _meta: meta });
    assert.equal(list.body.result.resultType, 'complete');
    assert.equal(list.body.result.cacheScope, 'private');
    await call(c, 'handshake_add', { tool: 'world-clock' });
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'world-clock__time_in', arguments: { place: 'Tokyo' }, _meta: meta });
    assert.equal(r.body.result.resultType, 'complete');
    assert.match(textOf(r.body.result), /Tokyo: /);
  });
});

describe('hub for people', () => {
  let s;
  before(async () => (s = await startStack()));
  after(() => s.close());

  test('the Add button connects the hub once and brings the tool along', async () => {
    const browser = new Browser();
    const page = await browser.get(`${s.base}/add/text-tools`);
    const html = await page.text();
    assert.match(html, /Connect your agent to Agent Handshake once/);
    assert.match(html, /add only Text Tools, as its own connector/);
    const c = await connect(s.base, null, { browser, form: { auto: '1', also: 'text-tools' } });
    assert.match(c.html, /Also add <b>Text Tools<\/b> now/);
    const list = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list');
    assert.ok(names(list).includes('text-tools__slugify'));

    // Next tool: one click from the browser, no trip to the agent app.
    const next = await browser.get(`${s.base}/add/world-clock`);
    assert.equal(next.headers.get('location'), '/hub/add/world-clock');
    const confirm = await (await browser.get(`${s.base}/hub/add/world-clock`)).text();
    const done = await browser.post(`${s.base}/hub/add/world-clock`, formFields(confirm));
    assert.equal(done.headers.get('location'), '/hub/added/world-clock');
    const list2 = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list');
    assert.ok(names(list2).includes('world-clock__time_in'));

    // The storefront knows this browser is connected.
    const home = await (await browser.get(`${s.base}/`)).text();
    assert.match(home, /Your agent is connected/);
    const my = await (await browser.get(`${s.base}/my`)).text();
    assert.match(my, /Your agent is connected/);
    assert.match(my, /Let my agent start free trials/);
  });

  test('when trials need approval, the agent gets a link for the person', async () => {
    const c = await connect(s.base, null, { form: { auto: '0' } });
    const r = await call(c, 'handshake_add', { tool: 'lumen-video' });
    const link = /(http\S+\/hub\/add\/lumen-video\?t=\S+)/.exec(textOf(r.body.result))[1];
    assert.equal(s.gw.store.find('entitlements', (e) => e.userId === s.gw.store.all('grants').at(-1).userId && e.serviceId === 'lumen-video').length, 0);
    const other = new Browser();
    const page = await other.get(link);
    const html = await page.text();
    assert.match(html, /Start free trial/);
    assert.equal(other.cookies.size, 0, 'the link does not sign the browser in');
    const done = await other.post(`${s.base}/hub/add/lumen-video`, formFields(html));
    assert.equal(done.status, 303);
    const list = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list');
    assert.ok(names(list).includes('lumen-video__create_project'));
  });

  test('storefront lists every tool with a try button', async () => {
    const html = await (await fetch(`${s.base}/`)).text();
    assert.match(html, /Every tool for your agent/);
    for (const t of ['Lumen Video', 'Quick Notes', 'World Clock', 'Text Tools', 'Unit Converter']) assert.ok(html.includes(t), t);
    assert.match(html, /Try free/);
    assert.match(html, /Connect your agent/);
  });
});
