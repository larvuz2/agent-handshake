// OAuth edge cases and client registration styles.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Browser, connect, formFields, pkce, rpc, startStack } from './helpers.js';
import { clearClientMetadataCache, isPrivateAddress } from '../src/oauth/cimd.js';
import { isAllowedRedirect, redirectMatches } from '../src/oauth/oauth.js';

describe('oauth', () => {
  let s;
  before(async () => (s = await startStack()));
  after(() => s.close());

  test('Client ID Metadata Document (CIMD) clients, loopback port can change', async () => {
    clearClientMetadataCache();
    const meta = createServer((req, res) => {
      const port = meta.address().port;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          client_id: `http://127.0.0.1:${port}/client.json`,
          client_name: 'CIMD Agent',
          redirect_uris: ['http://127.0.0.1/callback'],
          token_endpoint_auth_method: 'none',
        }),
      );
    });
    await new Promise((r) => meta.listen(0, '127.0.0.1', r));
    const clientId = `http://127.0.0.1:${meta.address().port}/client.json`;
    const c = await connect(s.base, 'quick-notes', { clientId, redirectUri: 'http://127.0.0.1:61234/callback' });
    assert.match(c.html, /CIMD Agent wants to add Quick Notes/);
    const r = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/call', { name: 'add_note', arguments: { text: 'hello' } });
    assert.match(r.body.result.content[0].text, /Saved note/);
    meta.close();
  });

  test('Cancel sends access_denied back to the app with iss', async () => {
    const r = await connect(s.base, 'quick-notes', { decision: 'deny' });
    assert.equal(r.error, 'access_denied');
    assert.equal(r.iss, s.base);
  });

  test('a missing resource is rejected when the gateway serves two tools', async () => {
    await assert.rejects(connect(s.base, 'quick-notes', { sendResource: false }), /authorize page 400/);
  });

  test('unknown redirect_uri shows an error page instead of redirecting', async () => {
    const reg = await (
      await fetch(`${s.base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://app.example/cb'] }),
      })
    ).json();
    const { challenge } = pkce();
    const url = `${s.base}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${s.base}/mcp/quick-notes`)}`;
    const r = await fetch(url, { redirect: 'manual' });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /redirect_uri does not match/);
  });

  test('an invalid request shows an error page instead of redirecting (no open redirect)', async () => {
    const reg = await (
      await fetch(`${s.base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://app.example/cb'] }),
      })
    ).json();
    const r = await fetch(`${s.base}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('https://app.example/cb')}&state=x`, {
      redirect: 'manual',
    });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /PKCE code_challenge is required/);
  });

  test('wrong PKCE verifier is rejected, and a code works only once', async () => {
    const browser = new Browser();
    const redirectUri = 'http://127.0.0.1:5000/cb';
    const reg = await (
      await fetch(`${s.base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_post' }),
      })
    ).json();
    assert.ok(reg.client_secret);
    const { verifier, challenge } = pkce();
    const resource = `${s.base}/mcp/quick-notes`;
    const page = await browser.get(
      `${s.base}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`,
    );
    const decided = await browser.post(`${s.base}/oauth/authorize`, { ...formFields(await page.text()), decision: 'allow' });
    const code = new URL(decided.headers.get('location')).searchParams.get('code');
    const tok = (extra) =>
      fetch(`${s.base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id, client_secret: reg.client_secret, ...extra }),
      });
    const noSecret = await fetch(`${s.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier }),
    });
    assert.equal(noSecret.status, 401);
    const bad = await tok({ code_verifier: pkce().verifier });
    assert.equal((await bad.json()).error, 'invalid_grant');
    // the failed attempt burned the code
    const good = await tok({ code_verifier: verifier });
    assert.equal(good.status, 400);
  });

  test('consent POST without the right CSRF token is refused', async () => {
    const browser = new Browser();
    const r = await browser.post(`${s.base}/oauth/authorize`, { request: 'x', csrf: 'nope', decision: 'allow' });
    assert.equal(r.status, 403);
  });

  test('RFC 7009 revocation ends the connection', async () => {
    const c = await connect(s.base, 'quick-notes');
    const r = await fetch(`${s.base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: c.tokens.refresh_token, client_id: c.client_id }),
    });
    assert.equal(r.status, 200);
    const call = await rpc(c.mcpUrl, c.tokens.access_token, 'tools/list');
    assert.equal(call.status, 401);
  });

  test('DCR rejects dangerous redirect URIs', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://ok.example/cb#frag']) {
      const r = await fetch(`${s.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri] }) });
      assert.equal(r.status, 400, uri);
    }
  });
});

describe('redirect rules', () => {
  test('allowed redirects', () => {
    assert.ok(isAllowedRedirect('https://claude.ai/api/mcp/auth_callback'));
    assert.ok(isAllowedRedirect('http://localhost:8787/callback'));
    assert.ok(isAllowedRedirect('cursor://anysphere.cursor-mcp/oauth/callback'));
    assert.ok(!isAllowedRedirect('http://example.com/cb'));
    assert.ok(!isAllowedRedirect('data:text/html,hi'));
  });
  test('loopback ignores the port, everything else is exact', () => {
    assert.ok(redirectMatches(['http://localhost/callback'], 'http://localhost:4242/callback'));
    assert.ok(redirectMatches(['http://127.0.0.1:33418'], 'http://127.0.0.1:50000'));
    assert.ok(!redirectMatches(['http://localhost/callback'], 'http://localhost:4242/other'));
    assert.ok(!redirectMatches(['https://a.example/cb'], 'https://a.example/cb2'));
  });
  test('private address detection for CIMD fetches', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.20.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
    for (const ip of ['8.8.8.8', '160.79.104.10', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  });
});
