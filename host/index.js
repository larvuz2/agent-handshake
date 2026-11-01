// Agent Handshake host kit: for agent apps (Hermes, your own) that want to read
// trial terms natively, keep a local usage ledger, show keep/drop labels, enforce
// one spend policy, and pin tool definitions. No dependencies.
//
//   import { discover, Ledger, SpendPolicy, toolsHash } from 'agent-handshake/host';

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TERMS_KEY, summarizeTerms } from '../src/terms.js';
import { label, labelFromDays, windowStats } from '../src/labels.js';
import { canonicalJson } from '../src/util/crypto.js';

export { TERMS_KEY, summarizeTerms, label, labelFromDays, windowStats };

const CARD_TYPE = 'application/mcp-server-card+json';
const CATALOG_TYPE = 'application/ai-catalog+json';

// ---------- install links ----------

/**
 * Understands every way a person can hand you a tool:
 *   agent-handshake://install?card=<server card URL>
 *   https://gateway/add/<id>          (install page)
 *   https://host/mcp/<id>/server-card (server card)
 *   https://host/mcp/<id>             (MCP URL; card is at <url>/server-card)
 *   https://example.com               (a site: look up /.well-known/ai-catalog.json)
 */
export function parseInstallLink(link) {
  const u = new URL(link);
  if (u.protocol === 'agent-handshake:') {
    const card = u.searchParams.get('card');
    if (!card) throw new Error('agent-handshake:// link has no card parameter');
    return { kind: 'card', url: card };
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`Unsupported link: ${link}`);
  if (/\/add\/[^/]+\/?$/.test(u.pathname)) return { kind: 'install-page', url: `${u.origin}${u.pathname.replace(/\/$/, '')}?format=json` };
  if (u.pathname.endsWith('/server-card')) return { kind: 'card', url: u.href };
  if (u.pathname === '/' || u.pathname === '') return { kind: 'site', url: `${u.origin}/.well-known/ai-catalog.json` };
  return { kind: 'mcp', url: `${u.href.replace(/\/$/, '')}/server-card` };
}

async function getJson(url, accept, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: `${accept}, application/json` }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch and check everything a consent screen needs.
 * @returns {Promise<Array<{cardUrl, card, mcpUrl, terms, summary, sameOrigin, warnings}>>}
 */
export async function discover(link, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const parsed = parseInstallLink(link);
  let cardUrls = [];
  if (parsed.kind === 'card' || parsed.kind === 'mcp') cardUrls = [parsed.url];
  else if (parsed.kind === 'install-page') {
    const info = await getJson(parsed.url, 'application/json', fetchImpl);
    cardUrls = [info.serverCard];
  } else {
    const catalog = await getJson(parsed.url, CATALOG_TYPE, fetchImpl);
    cardUrls = (catalog.entries || []).filter((e) => e.type === CARD_TYPE && e.url).map((e) => new URL(e.url, parsed.url).href);
  }
  const out = [];
  for (const cardUrl of cardUrls) {
    const card = await getJson(cardUrl, CARD_TYPE, fetchImpl);
    out.push(inspectCard(card, cardUrl));
  }
  return out;
}

export function inspectCard(card, cardUrl) {
  const remote = (card.remotes || []).find((r) => r.type === 'streamable-http') || (card.remotes || [])[0];
  const mcpUrl = remote?.url || null;
  const terms = card._meta?.[TERMS_KEY] || null;
  const warnings = [];
  // The MCP Registry verifies a namespace, not the remote URL. So check that the
  // card and the server it points to live on the same origin.
  const sameOrigin = Boolean(mcpUrl && cardUrl && new URL(mcpUrl).origin === new URL(cardUrl).origin);
  if (!mcpUrl) warnings.push('The server card has no remote URL.');
  else if (!sameOrigin) warnings.push(`The server (${new URL(mcpUrl).host}) is not on the same site as its card (${new URL(cardUrl).host}).`);
  if (mcpUrl && new URL(mcpUrl).protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(mcpUrl).hostname)) {
    warnings.push('The server does not use HTTPS.');
  }
  if (!terms) warnings.push('No Agent Handshake terms: no trial or spend limits are declared.');
  return { cardUrl, card, mcpUrl, terms, summary: terms ? summarizeTerms(terms) : null, sameOrigin, warnings };
}

// ---------- rug-pull protection ----------

// Hash of what the model sees. If it changes after approval, ask again.
export function toolsHash(tools) {
  const view = [...(tools || [])]
    .map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return `sha256:${createHash('sha256').update(canonicalJson(view)).digest('hex')}`;
}

// ---------- local usage ledger ----------

export class Ledger {
  /** @param {string} [file] JSON file; omit for memory only */
  constructor(file) {
    this.file = file;
    this.data = { servers: {} };
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8'));
  }

  addServer(id, info = {}) {
    this.data.servers[id] ||= { id, installedAt: Date.now(), days: {}, ...info };
    this.save();
    return this.data.servers[id];
  }

  removeServer(id) {
    delete this.data.servers[id];
    this.save();
  }

  record(id, { tool, ok, latencyMs = 0, costUsd = 0, at = Date.now() }) {
    const s = this.data.servers[id] || this.addServer(id);
    const day = new Date(at).toISOString().slice(0, 10);
    const b = (s.days[day] ||= { calls: 0, ok: 0, latencyMs: 0, costUsd: 0 });
    b.calls += 1;
    b.ok += ok ? 1 : 0;
    b.latencyMs += latencyMs;
    b.costUsd = Math.round((b.costUsd + costUsd) * 1e6) / 1e6;
    s.lastUsedAt = at;
    s.lastTool = tool;
    this.save();
  }

  stats(id, windowDays = 7, now = Date.now()) {
    return windowStats(this.data.servers[id]?.days || {}, now, windowDays);
  }

  label(id, now = Date.now(), opts) {
    const s = this.data.servers[id];
    if (!s) return null;
    return labelFromDays(s.days, s.installedAt, now, opts);
  }

  spent(windowDays, now = Date.now(), id) {
    const ids = id ? [id] : Object.keys(this.data.servers);
    return ids.reduce((n, k) => n + windowStats(this.data.servers[k]?.days || {}, now, windowDays).costUsd, 0);
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

// ---------- spend policy ----------

const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function camelize(v) {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [/[/.]/.test(k) ? k : camel(k), camelize(x)]));
  return v;
}

/**
 * One policy the person sets once; the host checks it before signing any payment.
 * Accepts camelCase or the snake_case keys from the build report:
 * { default: {perCallUsd, perDayUsd, perMonthUsd}, requireHumanAboveUsd,
 *   allowNetworks, allowAssets, services: { "<name>": {...} }, trialDefault: {spendUsd} }
 */
export class SpendPolicy {
  constructor(policy = {}) {
    const c = camelize(policy);
    const p = c.spendPolicy || c;
    this.policy = {
      default: { perCallUsd: 0.05, perDayUsd: 2, perMonthUsd: 20, ...(p.default || {}) },
      requireHumanAboveUsd: p.requireHumanAboveUsd ?? 1,
      allowNetworks: p.allowNetworks || null,
      allowAssets: p.allowAssets || null,
      services: p.services || {},
      trialDefault: { spendUsd: 0, ...(p.trialDefault || {}) },
    };
  }

  limitsFor(service) {
    return { ...this.policy.default, ...(this.policy.services[service] || {}) };
  }

  /**
   * @param {object} q
   * @param {string} q.service      server name, e.g. "com.lumenvideo/mcp"
   * @param {number} q.amountUsd
   * @param {string} [q.network]    e.g. "eip155:8453"
   * @param {string} [q.asset]      e.g. "USDC"
   * @param {boolean} [q.trial]     true while the tool is on a free trial
   * @param {Ledger} [q.ledger]     to count what was already spent
   * @param {string} [q.ledgerId]   the server id in the ledger
   * @returns {{decision: 'allow'|'ask'|'deny', reason?: string}}
   */
  check({ service, amountUsd, network, asset, trial = false, ledger, ledgerId }) {
    const p = this.policy;
    if (trial && amountUsd > p.trialDefault.spendUsd) return { decision: 'deny', reason: 'Trials have a spend limit of $0.' };
    if (network && p.allowNetworks && !p.allowNetworks.includes(network)) return { decision: 'deny', reason: `Network ${network} is not allowed.` };
    if (asset && p.allowAssets && !p.allowAssets.includes(asset)) return { decision: 'deny', reason: `Asset ${asset} is not allowed.` };
    const l = this.limitsFor(service);
    if (l.perCallUsd !== undefined && amountUsd > l.perCallUsd) {
      return amountUsd > p.requireHumanAboveUsd
        ? { decision: 'ask', reason: `$${amountUsd} is above the $${l.perCallUsd} per-call limit.` }
        : { decision: 'deny', reason: `$${amountUsd} is above the $${l.perCallUsd} per-call limit.` };
    }
    if (ledger) {
      const day = ledger.spent(1, Date.now(), ledgerId) + amountUsd;
      const month = ledger.spent(30, Date.now(), ledgerId) + amountUsd;
      const allDay = ledger.spent(1) + amountUsd;
      const allMonth = ledger.spent(30) + amountUsd;
      if (l.perDayUsd !== undefined && day > l.perDayUsd) return { decision: 'deny', reason: `Over the $${l.perDayUsd} daily limit.` };
      if (l.perMonthUsd !== undefined && month > l.perMonthUsd) return { decision: 'deny', reason: `Over the $${l.perMonthUsd} monthly limit.` };
      if (p.default.perDayUsd !== undefined && allDay > p.default.perDayUsd) return { decision: 'deny', reason: `Over the $${p.default.perDayUsd} daily limit across all tools.` };
      if (p.default.perMonthUsd !== undefined && allMonth > p.default.perMonthUsd) return { decision: 'deny', reason: `Over the $${p.default.perMonthUsd} monthly limit across all tools.` };
    }
    if (amountUsd > p.requireHumanAboveUsd) return { decision: 'ask', reason: `Payments above $${p.requireHumanAboveUsd} need your OK.` };
    return { decision: 'allow' };
  }
}

// ---------- uninstall ----------

// RFC 7009: revoke the refresh token so the gateway ends the connection.
export async function revoke({ revocationEndpoint, token, clientId, fetch: fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, token_type_hint: 'refresh_token', ...(clientId ? { client_id: clientId } : {}) }),
  });
  return res.ok;
}
