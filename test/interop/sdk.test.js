// Interop: the official MCP TypeScript SDK client connects through the gateway,
// does OAuth (discovery, DCR, PKCE, resource), and calls tools.
// Needs the dev dependency: npm install && npm run test:interop
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, formFields, startStack } from '../helpers.js';

let sdk;
try {
  sdk = {
    ...(await import('@modelcontextprotocol/sdk/client/index.js')),
    ...(await import('@modelcontextprotocol/sdk/client/streamableHttp.js')),
    ...(await import('@modelcontextprotocol/sdk/client/auth.js')),
  };
} catch {
  sdk = null;
}

class TestProvider {
  constructor() {
    this.saved = {};
  }
  get redirectUrl() {
    return 'http://127.0.0.1:53999/callback';
  }
  get clientMetadata() {
    return {
      client_name: 'MCP SDK Client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.saved.client;
  }
  saveClientInformation(c) {
    this.saved.client = c;
  }
  tokens() {
    return this.saved.tokens;
  }
  saveTokens(t) {
    this.saved.tokens = t;
  }
  redirectToAuthorization(url) {
    this.authUrl = url;
  }
  saveCodeVerifier(v) {
    this.saved.verifier = v;
  }
  codeVerifier() {
    return this.saved.verifier;
  }
}

test('official MCP SDK client: OAuth + tools through the gateway', { skip: !sdk && 'install dev dependencies first' }, async () => {
  const s = await startStack();
  try {
    const url = new URL(`${s.base}/mcp/lumen-video`);
    const provider = new TestProvider();
    const client = new sdk.Client({ name: 'sdk-interop', version: '1.0.0' });

    // 1. First connect fails with 401 -> the SDK discovers metadata, registers, and asks us to open the browser.
    await assert.rejects(client.connect(new sdk.StreamableHTTPClientTransport(url, { authProvider: provider })), (err) => err instanceof sdk.UnauthorizedError);
    assert.ok(provider.authUrl, 'SDK should have produced an authorization URL');
    assert.equal(provider.authUrl.searchParams.get('resource'), url.href);
    assert.equal(provider.authUrl.searchParams.get('code_challenge_method'), 'S256');

    // 2. The person approves in the browser.
    const browser = new Browser();
    const page = await browser.get(provider.authUrl.href);
    const html = await page.text();
    assert.match(html, /MCP SDK Client wants to add Lumen Video/);
    const decided = await browser.post(`${s.base}/oauth/authorize`, { ...formFields(html), decision: 'allow' });
    const code = new URL(decided.headers.get('location')).searchParams.get('code');

    // 3. The SDK swaps the code for tokens and connects.
    const transport = new sdk.StreamableHTTPClientTransport(url, { authProvider: provider });
    await transport.finishAuth(code);
    const client2 = new sdk.Client({ name: 'sdk-interop', version: '1.0.0' });
    await client2.connect(new sdk.StreamableHTTPClientTransport(url, { authProvider: provider }));

    const { tools } = await client2.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['list_projects', 'create_project', 'render_preview', 'handshake_status'],
    );
    const made = await client2.callTool({ name: 'create_project', arguments: { prompt: 'a red fox in fresh snow' } });
    assert.match(made.content[0].text, /Created prj_001/);
    const locked = await client2.callTool({ name: 'render_full', arguments: { projectId: 'prj_001' } });
    assert.equal(locked.isError, true);
    const status = await client2.callTool({ name: 'handshake_status', arguments: {} });
    assert.match(status.content[0].text, /1 of 100 calls used/);
    await client2.close();
  } finally {
    await s.close();
  }
});

test('official MCP SDK client: connect the hub once, then find, add and use tools', { skip: !sdk && 'install dev dependencies first' }, async () => {
  const s = await startStack();
  try {
    const url = new URL(`${s.base}/mcp`);
    const provider = new TestProvider();
    const client = new sdk.Client({ name: 'sdk-hub', version: '1.0.0' });
    await assert.rejects(client.connect(new sdk.StreamableHTTPClientTransport(url, { authProvider: provider })), (err) => err instanceof sdk.UnauthorizedError);
    assert.equal(provider.authUrl.searchParams.get('resource'), url.href);

    const browser = new Browser();
    const html = await (await browser.get(provider.authUrl.href)).text();
    assert.match(html, /MCP SDK Client wants to connect to Agent Handshake/);
    const decided = await browser.post(`${s.base}/oauth/authorize`, { ...formFields(html), auto: '1', decision: 'allow' });
    const code = new URL(decided.headers.get('location')).searchParams.get('code');
    await new sdk.StreamableHTTPClientTransport(url, { authProvider: provider }).finishAuth(code);

    const agent = new sdk.Client({ name: 'sdk-hub', version: '1.0.0' });
    let changed = 0;
    await agent.connect(new sdk.StreamableHTTPClientTransport(url, { authProvider: provider }));
    agent.setNotificationHandler((await import('@modelcontextprotocol/sdk/types.js')).ToolListChangedNotificationSchema, () => {
      changed++;
    });

    const first = await agent.listTools();
    assert.ok(first.tools.some((t) => t.name === 'handshake_search'));
    const found = await agent.callTool({ name: 'handshake_search', arguments: { query: 'convert units' } });
    assert.match(found.content[0].text, /Unit Converter \(unit-converter\)/);
    const added = await agent.callTool({ name: 'handshake_add', arguments: { tool: 'unit-converter' } });
    assert.match(added.content[0].text, /Added Unit Converter/);
    assert.equal(changed, 1, 'the SDK received tools/list_changed');
    const second = await agent.listTools();
    assert.ok(second.tools.some((t) => t.name === 'unit-converter__convert'));
    const r = await agent.callTool({ name: 'unit-converter__convert', arguments: { value: 5, from: 'mi', to: 'km' } });
    assert.match(r.content[0].text, /5 mi = 8\.0467 km/);
    await agent.close();
  } finally {
    await s.close();
  }
});
