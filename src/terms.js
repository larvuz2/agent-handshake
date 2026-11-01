// The `dev.handshake/terms` extension: plans, scopes and limits for one service.
// Shared by the gateway (to enforce) and the host library (to show consent).

export const TERMS_KEY = 'dev.handshake/terms';
export const TERMS_SPEC_VERSION = '0.1';

const INTERVALS = new Set(['day', 'week', 'month', 'year']);
const PERIODS = new Set(['total', 'day', 'month']);
// x402 networks with a built-in USDC address (see src/billing/x402.js).
export const KNOWN_X402_NETWORKS = new Set(['eip155:84532', 'eip155:8453']);
export const TESTNET_X402_NETWORKS = new Set(['eip155:84532']);

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid config:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

// ---------- normalize + validate ----------

export function normalizeService(raw, index = 0) {
  const p = [];
  const where = `services[${index}]${raw?.id ? ` (${raw.id})` : ''}`;
  if (!raw || typeof raw !== 'object') throw new ConfigError([`${where} must be an object`]);

  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    p.push(`${where}.id must be lowercase letters, digits and dashes (got ${JSON.stringify(id)})`);
  }
  const title = raw.title || raw.name || id;
  const upstream = raw.upstream || {};
  if (typeof upstream.url !== 'string' || !/^https?:\/\//.test(upstream.url)) {
    p.push(`${where}.upstream.url must be the http(s) URL of the MCP server you want to front`);
  }

  // Scopes: { "projects:read": { description, tools: [...] } }
  const scopes = {};
  for (const [name, s] of Object.entries(raw.scopes || {})) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(name)) p.push(`${where}.scopes: invalid scope name "${name}"`);
    if (typeof s === 'string') {
      scopes[name] = { description: s, tools: [] };
      continue;
    }
    const tools = Array.isArray(s?.tools) ? s.tools.map(String) : [];
    scopes[name] = { description: s?.description || name, tools };
  }

  const plansIn = Array.isArray(raw.plans) && raw.plans.length ? raw.plans : [{ id: 'trial', price: 0, durationDays: 14 }];
  const seen = new Set();
  const plans = plansIn.map((pl, i) => {
    const pw = `${where}.plans[${i}]`;
    if (!pl || typeof pl !== 'object') {
      p.push(`${pw} must be an object`);
      return null;
    }
    if (typeof pl.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(pl.id)) p.push(`${pw}.id must be lowercase (got ${JSON.stringify(pl.id)})`);
    if (seen.has(pl.id)) p.push(`${pw}.id "${pl.id}" is used twice`);
    seen.add(pl.id);

    let price = pl.price ?? 0;
    if (typeof price === 'number') {
      if (price < 0) p.push(`${pw}.price must not be negative`);
      // A plain number means USD per month.
      if (price !== 0) price = { amount: price, currency: 'USD', interval: 'month' };
    } else if (price && typeof price === 'object') {
      if (typeof price.amount !== 'number' || price.amount < 0) p.push(`${pw}.price.amount must be a number`);
      price = { amount: price.amount, currency: (price.currency || 'USD').toUpperCase(), interval: price.interval };
      if (price.interval && !INTERVALS.has(price.interval)) p.push(`${pw}.price.interval must be one of ${[...INTERVALS].join(', ')}`);
      if (price.amount === 0) price = 0;
    } else {
      p.push(`${pw}.price must be 0 or { amount, currency, interval }`);
    }

    const limits = {};
    if (pl.limits?.calls !== undefined) {
      if (!Number.isInteger(pl.limits.calls) || pl.limits.calls < 0) p.push(`${pw}.limits.calls must be a whole number`);
      limits.calls = pl.limits.calls;
    }
    if (pl.limits?.period !== undefined) {
      if (!PERIODS.has(pl.limits.period)) p.push(`${pw}.limits.period must be total, day or month`);
      limits.period = pl.limits.period;
    }
    if (pl.limits?.spendUsd !== undefined) limits.spendUsd = Number(pl.limits.spendUsd);

    const planScopes = Array.isArray(pl.scopes) ? pl.scopes.map(String) : ['*'];
    for (const s of planScopes) if (s !== '*' && !scopes[s]) p.push(`${pw}.scopes: "${s}" is not defined in ${where}.scopes`);

    let x402 = null;
    if (pl.x402) {
      const x = pl.x402;
      const amount = Number(x.pricePerCall);
      if (!(amount > 0) || amount < 0.000001) p.push(`${pw}.x402.pricePerCall must be a USD amount of at least 0.000001, like "0.01"`);
      if (!x.payTo) p.push(`${pw}.x402.payTo must be the wallet address that receives payments`);
      const network = x.network || 'eip155:84532';
      if (!KNOWN_X402_NETWORKS.has(network) && !x.assetAddress) {
        p.push(`${pw}.x402.assetAddress is required for network ${network} (USDC addresses are built in only for Base and Base Sepolia)`);
      }
      x402 = {
        pricePerCall: typeof x.pricePerCall === 'number' ? trimZeros(x.pricePerCall.toFixed(6)) : String(x.pricePerCall),
        asset: x.asset || 'USDC',
        network,
        payTo: x.payTo,
        assetAddress: x.assetAddress,
        assetDecimals: x.assetDecimals ?? 6,
        assetName: x.assetName,
        assetVersion: x.assetVersion,
      };
    }

    if (pl.durationDays !== undefined && (!(pl.durationDays > 0) || typeof pl.durationDays !== 'number')) {
      p.push(`${pw}.durationDays must be a positive number`);
    }

    return {
      id: pl.id,
      title: pl.title || defaultPlanTitle(pl.id, price, pl.durationDays, x402),
      price,
      durationDays: pl.durationDays,
      limits,
      scopes: planScopes,
      default: Boolean(pl.default),
      checkoutUrl: pl.checkoutUrl,
      stripePriceId: pl.stripePriceId,
      x402,
    };
  });

  if (raw.name !== undefined && (typeof raw.name !== 'string' || !/^[^/]{1,99}\/[^/]{1,100}$/.test(raw.name) || raw.name.length < 3)) {
    p.push(`${where}.name must look like "com.example/server" (exactly one "/"), as in the MCP Registry`);
  }
  const publisher = raw.publisher || {};
  const service = {
    id,
    name: raw.name || `local.handshake/${id}`,
    title,
    description: raw.description || '',
    version: raw.version || '1.0.0',
    icon: raw.icon,
    websiteUrl: raw.websiteUrl || publisher.url,
    publisher: { name: publisher.name || title, domain: publisher.domain, url: publisher.url },
    upstream: { url: upstream.url, headers: upstream.headers || {}, timeoutMs: upstream.timeoutMs || 120000 },
    scopes,
    plans: plans.filter(Boolean),
    statusTool: raw.statusTool !== false,
    hideLockedTools: raw.hideLockedTools !== false,
    trialsPerIpPerDay: raw.trialsPerIpPerDay ?? 5,
  };
  if (p.length) throw new ConfigError(p);
  return service;
}

function defaultPlanTitle(id, price, durationDays, x402) {
  if (x402) return 'Pay per call';
  if (price === 0 && durationDays) return 'Free trial';
  if (price === 0) return 'Free';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// ---------- plan helpers ----------

export function defaultPlan(service) {
  return (
    service.plans.find((p) => p.default) ||
    service.plans.find((p) => p.id === 'trial') ||
    service.plans.find((p) => isFree(p) && !p.x402) ||
    service.plans[0]
  );
}

export function planById(service, id) {
  return service.plans.find((p) => p.id === id) || null;
}

export function isFree(plan) {
  return plan.price === 0 && !plan.x402;
}

export function isTrial(plan) {
  return isFree(plan) && Boolean(plan.durationDays);
}

// Plans someone can move to after (or instead of) the trial.
export function upgradePlans(service) {
  return service.plans.filter((p) => !isFree(p));
}

export function freePlan(service) {
  return service.plans.find((p) => isFree(p) && !p.durationDays) || null;
}

export function priceLabel(plan) {
  if (plan.x402) return `$${trimZeros(plan.x402.pricePerCall)} per call`;
  if (plan.price === 0) return plan.durationDays ? `Free for ${plan.durationDays} days` : 'Free';
  const amount = formatMoney(plan.price.amount, plan.price.currency);
  return plan.price.interval ? `${amount}/${shortInterval(plan.price.interval)}` : amount;
}

export function formatMoney(amount, currency = 'USD') {
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : `${currency} `;
  const s = Number.isInteger(amount) ? String(amount) : Number(amount).toFixed(2);
  return `${sym}${s}`;
}

function shortInterval(i) {
  return { day: 'day', week: 'wk', month: 'mo', year: 'yr' }[i] || i;
}

function trimZeros(s) {
  return String(s).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

// ---------- scopes -> tools ----------

// Tools not listed under any scope are open on every plan.
export function planAllowsTool(service, plan, toolName) {
  if (plan.scopes.includes('*')) return true;
  const owners = Object.entries(service.scopes).filter(([, s]) => s.tools.includes(toolName));
  if (owners.length === 0) return true;
  return owners.some(([name]) => plan.scopes.includes(name));
}

// Which paid plan would unlock a tool (for "upgrade to unlock" messages).
export function planThatUnlocks(service, toolName) {
  return upgradePlans(service).find((p) => planAllowsTool(service, p, toolName)) || null;
}

export function scopeDescriptions(service, plan) {
  if (plan.scopes.includes('*') || Object.keys(service.scopes).length === 0) return ['Use all of its tools'];
  return plan.scopes.map((s) => service.scopes[s]?.description || s);
}

// ---------- public terms document ----------

export function termsExtension(service, gatewayUrl) {
  return {
    specVersion: TERMS_SPEC_VERSION,
    gateway: gatewayUrl,
    install: `${gatewayUrl}/add/${service.id}`,
    manage: `${gatewayUrl}/my`,
    defaultPlan: defaultPlan(service).id,
    scopes: Object.fromEntries(Object.entries(service.scopes).map(([k, v]) => [k, { description: v.description }])),
    plans: service.plans.map((p) => {
      const out = { id: p.id, title: p.title, price: p.price };
      if (p.durationDays) out.durationDays = p.durationDays;
      if (Object.keys(p.limits).length) out.limits = p.limits;
      out.scopes = p.scopes;
      if (!isFree(p) && !p.x402) out.checkoutUrl = `${gatewayUrl}/upgrade?service=${service.id}&plan=${p.id}`;
      if (p.x402) out.x402 = { pricePerCall: p.x402.pricePerCall, asset: p.x402.asset, network: p.x402.network };
      if (isTrial(p) && p.limits.spendUsd === undefined) out.limits = { ...(out.limits || {}), spendUsd: 0 };
      return out;
    }),
    uninstall: { revocationEndpoint: `${gatewayUrl}/oauth/revoke` },
  };
}

// Three plain-language lines for a consent screen. Works on the public terms
// document, so hosts can use it without the gateway.
export function summarizeTerms(terms, planId) {
  const plan = terms.plans.find((p) => p.id === (planId || terms.defaultPlan)) || terms.plans[0];
  const scopes = plan.scopes || ['*'];
  const access =
    scopes.includes('*') || !terms.scopes || Object.keys(terms.scopes).length === 0
      ? ['Use all of its tools']
      : scopes.map((s) => terms.scopes[s]?.description || s);

  let duration;
  if (plan.x402) duration = `$${trimZeros(plan.x402.pricePerCall)} per call, paid by your agent`;
  else if (plan.price === 0 && plan.durationDays) duration = `Free for ${plan.durationDays} days`;
  else if (plan.price === 0) duration = 'Free';
  else duration = priceLabel({ ...plan, x402: null });
  if (plan.limits?.calls !== undefined) {
    const per = plan.limits.period === 'day' ? ' a day' : plan.limits.period === 'month' ? ' a month' : '';
    duration += ` · up to ${plan.limits.calls} calls${per}`;
  }

  const spendCap = plan.limits?.spendUsd ?? (plan.price === 0 && !plan.x402 ? 0 : undefined);
  const spend =
    spendCap === 0
      ? 'Spend limit: $0. No card needed.'
      : spendCap !== undefined
        ? `Spend limit: ${formatMoney(spendCap)}`
        : 'You approve every payment';

  return { plan, access, duration, spend, lines: [access.join(' · '), duration, spend] };
}
