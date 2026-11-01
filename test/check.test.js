import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './helpers.js';
import { checkHub } from '../src/check.js';

test('check: a healthy hub passes every check', async () => {
  const s = await startStack();
  try {
    const results = await checkHub(s.base);
    const failed = results.filter((r) => !r.ok);
    assert.deepEqual(failed, []);
    assert.ok(results.some((r) => r.name === 'Tool card: Lumen Video'));
  } finally {
    await s.close();
  }
});

test('check: a wrong public address is caught with a fix', async () => {
  const s = await startStack();
  try {
    const wrong = s.base.replace('127.0.0.1', 'localhost');
    const results = await checkHub(wrong);
    const meta = results.find((r) => r.name === 'OAuth metadata');
    assert.equal(meta.ok, false);
    assert.match(meta.fix, /PUBLIC_URL/);
  } finally {
    await s.close();
  }
});

test('check: an unreachable address fails cleanly', async () => {
  const results = await checkHub('http://127.0.0.1:9');
  assert.ok(results.some((r) => !r.ok && r.name === 'Hub is up'));
});
