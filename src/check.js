// Checks a running hub from the outside, the way agent apps will see it.
// Used by `agent-handshake check <url>` right after you deploy.

async function get(url, init) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { res, text, json };
}

/**
 * @param {string} base public URL of the hub, e.g. https://hub.example.com
 * @returns {Promise<Array<{name: string, ok: boolean, detail?: string, fix?: string}>>}
 */
export async function checkHub(base) {
  base = String(base).replace(/\/+$/, '');
  const out = [];
  const add = (name, ok, detail, fix) => out.push({ name, ok: Boolean(ok), detail, fix });
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      add(name, false, err.cause?.code || err.message, 'Is the hub running and reachable at this address?');
    }
  };

  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(base);
  add(
    'HTTPS',
    base.startsWith('https://') || local,
    base.startsWith('https://') ? 'yes' : local ? 'local address (fine for Claude Code, Cursor, VS Code on this computer)' : 'no',
    'claude.ai and ChatGPT need https://. Deploy behind HTTPS or use a tunnel.',
  );

  await step('Hub is up', async () => {
    const { res, json } = await get(`${base}/healthz`);
    add('Hub is up', res.ok && json?.ok, res.ok ? `${json?.services?.length ?? 0} tools` : `HTTP ${res.status}`);
  });

  await step('OAuth metadata', async () => {
    const { res, json } = await get(`${base}/.well-known/oauth-authorization-server`);
    const ok = res.ok && json?.issuer === base && json?.code_challenge_methods_supported?.includes('S256') && json?.registration_endpoint;
    add(
      'OAuth metadata',
      ok,
      res.ok ? `issuer ${json?.issuer}` : `HTTP ${res.status}`,
      json?.issuer && json.issuer !== base ? `The issuer must match the address agents use. Set PUBLIC_URL=${base} and restart.` : undefined,
    );
  });

  await step('Hub resource metadata', async () => {
    const { res, json } = await get(`${base}/.well-known/oauth-protected-resource/mcp`);
    add('Hub resource metadata', res.ok && json?.resource === `${base}/mcp`, res.ok ? json?.resource : `HTTP ${res.status}`, `Set PUBLIC_URL=${base} and restart.`);
  });

  await step('Sign-in prompt', async () => {
    const { res } = await get(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const www = res.headers.get('www-authenticate') || '';
    add('Sign-in prompt', res.status === 401 && www.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`), `HTTP ${res.status}`, 'Agent apps need a 401 with WWW-Authenticate to start sign-in. Check PUBLIC_URL and any proxy in front.');
  });

  await step('Client registration', async () => {
    const { res, json } = await get(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'agent-handshake check', redirect_uris: ['http://127.0.0.1/callback'] }),
    });
    add('Client registration', res.status === 201 && json?.client_id, res.status === 201 ? 'works (Cursor and older apps use it)' : `HTTP ${res.status}`);
  });

  await step('Hub server card', async () => {
    const { res, json } = await get(`${base}/mcp/server-card`);
    const tools = json?._meta?.['dev.handshake/hub']?.tools || [];
    add('Hub server card', res.ok && json?.remotes?.[0]?.url === `${base}/mcp`, res.ok ? `${tools.length} tools listed` : `HTTP ${res.status}`);
    for (const t of tools.slice(0, 50)) {
      const card = await get(t.card);
      add(`Tool card: ${t.title}`, card.res.ok && card.json?._meta?.['dev.handshake/terms'], card.res.ok ? 'terms published' : `HTTP ${card.res.status}`);
    }
  });

  await step('AI Catalog', async () => {
    const { res, json } = await get(`${base}/.well-known/ai-catalog.json`);
    add('AI Catalog', res.ok && json?.entries?.[0]?.url === `${base}/mcp/server-card`, res.ok ? `${json?.entries?.length ?? 0} entries, hub first` : `HTTP ${res.status}`);
  });

  await step('llms.txt for agents', async () => {
    const { res, text } = await get(`${base}/llms.txt`);
    add('llms.txt for agents', res.ok && text.includes('If you are an AI agent'), res.ok ? 'present' : `HTTP ${res.status}`);
  });

  await step('Pages', async () => {
    for (const path of ['/', '/connect', '/agents', '/my']) {
      const { res } = await get(`${base}${path}`);
      add(`Page ${path}`, res.ok, `HTTP ${res.status}`);
    }
  });

  return out;
}
