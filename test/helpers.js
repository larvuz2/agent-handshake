// Test helpers: a scripted "agent app" that does the real OAuth + MCP dance.

import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/server.js';
import { buildConfig } from '../src/config.js';
import { createDemoUpstream, demoConfig } from '../examples/demo/server.js';

export async function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Start the demo upstream + a gateway. `mutate(raw)` can change the raw config.
 */
export async function startStack({ sse = false, mutate, paymentsMode = 'test', fetchImpl, env = {} } = {}) {
  const secret = randomBytes(8).toString('hex');
  const upstream = createDemoUpstream({ secret, sse });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const raw = demoConfig({ upstreamUrl, secret });
  if (mutate) mutate(raw);
  const port = await freePort();
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const config = buildConfig(raw, {
    overrides: { port, publicUrl: `http://127.0.0.1:${port}`, dataDir: mkdtempSync(join(tmpdir(), 'ah-test-')), paymentsMode, quiet: true },
  });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const gw = createGateway(config, { memory: true, fetchImpl });
  await gw.listen(port, '127.0.0.1');
  const base = config.publicUrl;
  return {
    gw,
    base,
    upstream,
    upstreamUrl,
    async close() {
      await gw.close();
      await new Promise((r) => upstream.close(r));
    },
  };
}

// A browser with a cookie jar.
export class Browser {
  constructor() {
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  async fetch(url, init = {}) {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers || {}), cookie: this.cookieHeader() } });
    this.store(res);
    return res;
  }
  async get(url) {
    return this.fetch(url);
  }
  async post(url, form) {
    return this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  }
}

export function formFields(html) {
  const out = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1];
    if (name) out[name] = (value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  return out;
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Do what an MCP client does: hit the server, follow WWW-Authenticate to the
 * metadata, register (DCR) or use a CIMD client_id, run the authorize step in a
 * browser, approve, and swap the code for tokens.
 */
export async function connect(base, serviceId, { browser = new Browser(), clientId, redirectUri = 'http://127.0.0.1:53682/callback', decision = 'allow', sendResource = true, form = {} } = {}) {
  // serviceId null = the hub at /mcp
  const mcpUrl = serviceId ? `${base}/mcp/${serviceId}` : `${base}/mcp`;
  const r401 = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (r401.status !== 401) throw new Error(`expected 401, got ${r401.status}`);
  const prmUrl = /resource_metadata="([^"]+)"/.exec(r401.headers.get('www-authenticate'))[1];
  const prm = await (await fetch(prmUrl)).json();
  const asMeta = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();

  let client_id = clientId;
  let client_secret;
  if (!client_id) {
    const reg = await fetch(asMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test Agent', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
    });
    const client = await reg.json();
    client_id = client.client_id;
    client_secret = client.client_secret;
  }

  const { verifier, challenge } = pkce();
  const state = randomBytes(6).toString('hex');
  const auth = new URL(asMeta.authorization_endpoint);
  auth.search = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...(sendResource ? { resource: prm.resource } : {}),
  }).toString();
  const page = await browser.get(auth.toString());
  const html = await page.text();
  if (page.status !== 200) throw Object.assign(new Error(`authorize page ${page.status}`), { html, status: page.status });
  const fields = formFields(html);
  const decided = await browser.post(`${base}/oauth/authorize`, { ...fields, ...form, decision });
  const location = decided.headers.get('location');
  if (!location) throw Object.assign(new Error(`no redirect after consent (${decided.status})`), { html: await decided.text() });
  const back = new URL(location);
  if (back.searchParams.get('state') !== state) throw new Error('state mismatch');
  if (back.searchParams.get('error')) return { error: back.searchParams.get('error'), iss: back.searchParams.get('iss'), browser };
  const code = back.searchParams.get('code');
  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id, resource: prm.resource }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`token error: ${JSON.stringify(tokens)}`);
  return { tokens, client_id, client_secret, browser, mcpUrl, iss: back.searchParams.get('iss'), asMeta, prm, redirectUri, html };
}

let rpcId = 1;
export async function rpc(mcpUrl, token, method, params = {}, { sessionId, headers = {}, raw = false } = {}) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let body;
  if (ct.includes('text/event-stream')) {
    const datas = text
      .split(/\n\n/)
      .map((e) => e.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
      .filter(Boolean);
    body = JSON.parse(datas[datas.length - 1]);
  } else {
    body = text ? JSON.parse(text) : null;
  }
  return { status: res.status, body, headers: res.headers, sessionId: res.headers.get('mcp-session-id') };
}

export async function initSession(mcpUrl, token, capabilities = {}) {
  const r = await rpc(mcpUrl, token, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities,
    clientInfo: { name: 'test-agent', title: 'Test Agent', version: '1.0.0' },
  });
  return r.sessionId;
}

export function textOf(result) {
  return (result?.content || []).map((c) => c.text).join('\n');
}
