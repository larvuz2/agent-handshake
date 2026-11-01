import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, normalizeService, summarizeTerms, termsExtension, planAllowsTool, priceLabel, defaultPlan } from '../src/terms.js';
import { label, labelFromDays } from '../src/labels.js';
import { installTargets, installLinks } from '../src/links.js';
import { transformSse, parseSseMessages } from '../src/mcp/sse.js';
import { sign, verify, pkceMatches } from '../src/util/crypto.js';
import { html, toString } from '../src/util/html.js';
import { buildConfig } from '../src/config.js';

const base = {
  id: 'demo',
  title: 'Demo',
  upstream: { url: 'https://mcp.example.com/mcp' },
  scopes: { read: { description: 'Read things', tools: ['get'] }, write: { description: 'Write things', tools: ['put'] } },
  plans: [
    { id: 'trial', price: 0, durationDays: 7, limits: { calls: 50 }, scopes: ['read'] },
    { id: 'pro', price: { amount: 12, currency: 'USD', interval: 'month' }, scopes: ['read', 'write'] },
  ],
};

describe('terms', () => {
  test('normalize and summarize', () => {
    const s = normalizeService(base);
    assert.equal(defaultPlan(s).id, 'trial');
    const sum = summarizeTerms(termsExtension(s, 'https://gw.example'));
    assert.deepEqual(sum.lines, ['Read things', 'Free for 7 days · up to 50 calls', 'Spend limit: $0. No card needed.']);
    assert.equal(priceLabel(s.plans[1]), '$12/mo');
  });

  test('tools are gated by scope; unmapped tools are open', () => {
    const s = normalizeService(base);
    assert.ok(planAllowsTool(s, s.plans[0], 'get'));
    assert.ok(!planAllowsTool(s, s.plans[0], 'put'));
    assert.ok(planAllowsTool(s, s.plans[1], 'put'));
    assert.ok(planAllowsTool(s, s.plans[0], 'something_else'));
  });

  test('no plans means a 14-day trial with all tools', () => {
    const s = normalizeService({ id: 'x', upstream: { url: 'http://localhost:1/mcp' } });
    assert.equal(s.plans[0].durationDays, 14);
    assert.deepEqual(summarizeTerms(termsExtension(s, 'http://x')).access, ['Use all of its tools']);
  });

  test('helpful config errors', () => {
    assert.throws(
      () => normalizeService({ id: 'Bad Id', upstream: {}, plans: [{ id: 'a', scopes: ['nope'] }] }),
      (err) => err instanceof ConfigError && err.problems.length === 3,
    );
    assert.throws(() => normalizeService({ ...base, name: 'no-slash' }), /exactly one/);
  });

  test('env substitution and missing env vars', () => {
    process.env.AH_TEST_TOKEN = 'secret123';
    const cfg = buildConfig({ services: [{ ...base, upstream: { url: base.upstream.url, headers: { authorization: 'Bearer ${env:AH_TEST_TOKEN}' } } }] }, { overrides: { quiet: true } });
    assert.equal(cfg.services[0].upstream.headers.authorization, 'Bearer secret123');
    assert.throws(() => buildConfig({ services: [{ ...base, upstream: { url: '${env:AH_NOPE_NOT_SET}' } }] }), /AH_NOPE_NOT_SET/);
  });
});

describe('labels', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const day = 86400000;
  test('rules', () => {
    assert.equal(label({ calls7d: 24, successRate7d: 0.96, calls14d: 30, installedAt: now - 10 * day }, now).text, 'Working great');
    assert.equal(label({ calls7d: 0, successRate7d: null, calls14d: 0, installedAt: now - 20 * day }, now).text, 'Unused');
    assert.equal(label({ calls7d: 0, successRate7d: null, calls14d: 0, installedAt: now - 1 * day }, now).text, 'Just added');
    assert.equal(label({ calls7d: 2, successRate7d: 1, calls14d: 2, installedAt: now - 10 * day }, now).text, 'Try more');
    assert.equal(label({ calls7d: 10, successRate7d: 0.3, calls14d: 10, installedAt: now - 10 * day }, now).text, 'Having trouble');
    assert.equal(label({ calls7d: 4, successRate7d: 1, calls14d: 4, installedAt: now - 10 * day, costPerOkUsd: 0.5 }, now).text, 'Expensive');
  });
  test('from daily buckets', () => {
    const days = { '2026-11-01': { calls: 12, ok: 12, latencyMs: 1200, costUsd: 0 } };
    assert.equal(labelFromDays(days, now - 3 * day, now).id, 'working-great');
  });
});

describe('install links', () => {
  test('formats per app', () => {
    const links = installLinks({ name: 'lumen', url: 'https://gw.example/mcp/lumen', title: 'Lumen Video' });
    assert.equal(links.claude, 'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Lumen%20Video&connectorUrl=https%3A%2F%2Fgw.example%2Fmcp%2Flumen');
    const cfg = JSON.parse(Buffer.from(decodeURIComponent(links.cursor.split('config=')[1]), 'base64').toString());
    assert.deepEqual(cfg, { url: 'https://gw.example/mcp/lumen' });
    assert.deepEqual(JSON.parse(decodeURIComponent(links.vscode.slice('vscode:mcp/install?'.length))), { name: 'lumen', type: 'http', url: 'https://gw.example/mcp/lumen' });
    assert.match(links.goose, /^goose:\/\/extension\?url=https%3A%2F%2Fgw\.example%2Fmcp%2Flumen&type=streamable_http/);
    assert.equal(links['claude-code'], 'claude mcp add --transport http lumen https://gw.example/mcp/lumen');
    assert.ok(installTargets({ name: 'x', url: 'https://x' }).every((t) => t.steps.length >= 1));
  });
});

describe('sse', () => {
  test('rewrites only the messages we change, keeps the rest byte for byte', async () => {
    const input = ': hello\n\nid: 1\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n';
    const chunks = [input.slice(0, 20), input.slice(20, 61), input.slice(61)];
    const stream = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    let out = '';
    await transformSse(stream, (s) => (out += s), (m) => (m.id === 1 ? { ...m, result: { a: 2 } } : m));
    assert.match(out, /^: hello\n\nid: 1\nevent: message\ndata: \{"jsonrpc":"2.0","id":1,"result":\{"a":2\}\}\n\n/);
    assert.ok(out.endsWith('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'));
    assert.equal(parseSseMessages(out).length, 2);
  });
});

describe('crypto + html', () => {
  test('signed blobs expire and resist tampering', () => {
    const t = sign('k', { a: 1 }, 60);
    assert.equal(verify('k', t).a, 1);
    assert.equal(verify('other', t), null);
    assert.equal(verify('k', `${t}x`), null);
    assert.equal(verify('k', sign('k', { a: 1 }, -1)), null);
  });
  test('PKCE', () => {
    // RFC 7636 appendix B
    assert.ok(pkceMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
    assert.ok(!pkceMatches('short', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
  });
  test('html escapes by default', () => {
    assert.equal(toString(html`<p>${'<script>"x"</script>'}</p>`), '<p>&lt;script&gt;&quot;x&quot;&lt;/script&gt;</p>');
  });
});
