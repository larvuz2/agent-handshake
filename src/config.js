import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomToken } from './util/crypto.js';
import { ConfigError, normalizeService } from './terms.js';

const ENV_RE = /\$\{env:([A-Z0-9_]+)\}/g;

function substituteEnv(value, missing) {
  if (typeof value === 'string') {
    return value.replace(ENV_RE, (_, name) => {
      if (process.env[name] === undefined) {
        missing.add(name);
        return '';
      }
      return process.env[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => substituteEnv(v, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v, missing)]));
  }
  return value;
}

export function readConfigFile(file) {
  const path = resolve(file);
  if (!existsSync(path)) throw new ConfigError([`Config file not found: ${path}. Run "agent-handshake init" to create one.`]);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError([`${path} is not valid JSON: ${err.message}`]);
  }
  return { raw, dir: dirname(path) };
}

/**
 * Build the runtime config from a raw object (from a file or code).
 * Env vars win over the file for deployment settings.
 */
export function buildConfig(raw, { baseDir = process.cwd(), overrides = {} } = {}) {
  const missing = new Set();
  const cfg = substituteEnv(raw, missing);
  if (missing.size) {
    throw new ConfigError([...missing].map((n) => `Environment variable ${n} is used in the config but not set`));
  }

  const port = Number(overrides.port ?? process.env.PORT ?? cfg.port ?? 7410);
  const host = overrides.host ?? process.env.HOST ?? cfg.host ?? '0.0.0.0';
  let publicUrl = overrides.publicUrl ?? process.env.PUBLIC_URL ?? cfg.publicUrl ?? `http://localhost:${port}`;
  publicUrl = publicUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicUrl)) throw new ConfigError([`publicUrl must start with http:// or https:// (got ${publicUrl})`]);

  const dataDir = resolve(baseDir, overrides.dataDir ?? process.env.DATA_DIR ?? cfg.dataDir ?? '.handshake');

  if (!Array.isArray(cfg.services) || cfg.services.length === 0) {
    throw new ConfigError(['services must list at least one MCP server to put behind the gateway']);
  }
  const problems = [];
  const services = [];
  cfg.services.forEach((s, i) => {
    try {
      services.push(normalizeService(s, i));
    } catch (err) {
      if (err instanceof ConfigError) problems.push(...err.problems);
      else throw err;
    }
  });
  const ids = new Set();
  for (const s of services) {
    if (ids.has(s.id)) problems.push(`Two services use the id "${s.id}"`);
    ids.add(s.id);
  }
  if (problems.length) throw new ConfigError(problems);

  const stripeKey = process.env.STRIPE_SECRET_KEY || cfg.payments?.stripe?.secretKey;
  const mode = overrides.paymentsMode ?? process.env.PAYMENTS_MODE ?? cfg.payments?.mode ?? (stripeKey ? 'stripe' : 'test');
  if (!['test', 'stripe', 'external'].includes(mode)) problems.push(`payments.mode must be test, stripe or external (got ${mode})`);
  if (mode === 'stripe' && !stripeKey) problems.push('payments.mode is "stripe" but STRIPE_SECRET_KEY is not set');
  if (problems.length) throw new ConfigError(problems);

  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(publicUrl);
  return {
    built: true,
    name: cfg.name || 'Agent Handshake',
    publicUrl,
    port,
    host,
    dataDir,
    local,
    services,
    payments: {
      mode,
      stripe: {
        secretKey: stripeKey,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || cfg.payments?.stripe?.webhookSecret,
        apiBase: process.env.STRIPE_API_BASE || cfg.payments?.stripe?.apiBase || 'https://api.stripe.com',
      },
      x402: {
        facilitatorUrl: process.env.X402_FACILITATOR_URL || cfg.payments?.x402?.facilitatorUrl || 'https://x402.org/facilitator',
      },
    },
    // Allow http:// client metadata documents and private addresses only for local dev.
    allowInsecureClientMetadata: overrides.allowInsecureClientMetadata ?? (cfg.allowInsecureClientMetadata ?? local),
    accessTokenTtl: cfg.accessTokenTtlSeconds ?? 3600,
    refreshTokenTtl: cfg.refreshTokenTtlSeconds ?? 90 * 86400,
    secret: overrides.secret ?? process.env.HANDSHAKE_SECRET,
    adminKey: overrides.adminKey ?? process.env.HANDSHAKE_ADMIN_KEY,
    quiet: overrides.quiet ?? false,
  };
}

// Persist generated secrets next to the data so restarts keep sessions.
export function ensureSecrets(config) {
  const file = join(config.dataDir, 'secrets.json');
  let saved = {};
  if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8'));
  let changed = false;
  if (!config.secret) {
    if (!saved.secret) {
      saved.secret = randomToken(32);
      changed = true;
    }
    config.secret = saved.secret;
  }
  let generatedAdminKey = false;
  if (!config.adminKey) {
    if (!saved.adminKey) {
      saved.adminKey = `ahk_${randomToken(18)}`;
      changed = true;
      generatedAdminKey = true;
    }
    config.adminKey = saved.adminKey;
  }
  if (changed) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
  return { generatedAdminKey, secretsFile: file };
}
