#!/usr/bin/env node
// Agent Handshake CLI. No dependencies.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { buildConfig, readConfigFile } from '../src/config.js';
import { createGateway } from '../src/server.js';
import { ConfigError, priceLabel, summarizeTerms, termsExtension } from '../src/terms.js';
import { installLinks } from '../src/links.js';
import { serverCard } from '../src/discovery.js';
import { createDemoUpstream, demoConfig } from '../examples/demo/server.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, blue: (s) => `\x1b[34m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` }
  : { b: String, dim: String, blue: String, green: String, red: String, yellow: String };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const key = k.replace(/-([a-z])/g, (_, x) => x.toUpperCase());
      if (v !== undefined) args[key] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) args[key] = argv[++i];
      else args[key] = true;
    } else if (a === '-c') args.config = argv[++i];
    else if (a === '-p') args.port = argv[++i];
    else if (a === '-h') args.help = true;
    else if (a === '-v') args.version = true;
    else args._.push(a);
  }
  return args;
}

const HELP = `
${c.b('Agent Handshake')} ${pkg.version}: add to my agent, three clicks, zero pasting.

${c.b('Usage')}
  agent-handshake demo                 Run the demo: gateway + two sample tools, no setup
  agent-handshake init                 Create handshake.config.json for your MCP server
  agent-handshake start                Start the gateway with handshake.config.json
  agent-handshake validate             Check the config and that your MCP server answers
  agent-handshake links <service-id>   Print install links, the button, and badge code
  agent-handshake card <service-id>    Print the MCP server card
  agent-handshake auto                 Start with your config if there is one, else the demo (for containers)

${c.b('Options')}
  -c, --config <file>    Config file (default: handshake.config.json)
  -p, --port <port>      Port (default: 7410, or PORT)
  --public-url <url>     Public URL of the gateway (default: http://localhost:<port>, or PUBLIC_URL)
  --data-dir <dir>       Where data is stored (default: .handshake, or DATA_DIR)

${c.b('Environment')}
  PUBLIC_URL, PORT, DATA_DIR, HANDSHAKE_CONFIG, HANDSHAKE_CONFIG_JSON,
  HANDSHAKE_SECRET, HANDSHAKE_ADMIN_KEY, PAYMENTS_MODE,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, X402_FACILITATOR_URL

Docs: https://github.com/larvuz2/agent-handshake
`;

function fail(err) {
  if (err instanceof ConfigError) {
    console.error(`${c.red('Config problem')}\n  - ${err.problems.join('\n  - ')}`);
  } else {
    console.error(c.red(err.stack || err.message || String(err)));
  }
  process.exit(1);
}

// Config comes from --config, HANDSHAKE_CONFIG (a path), HANDSHAKE_CONFIG_JSON
// (the whole JSON, handy on hosting platforms), or ./handshake.config.json.
function loadConfig(args) {
  let raw;
  let dir = process.cwd();
  if (!args.config && process.env.HANDSHAKE_CONFIG_JSON) {
    try {
      raw = JSON.parse(process.env.HANDSHAKE_CONFIG_JSON);
    } catch (err) {
      throw new ConfigError([`HANDSHAKE_CONFIG_JSON is not valid JSON: ${err.message}`]);
    }
  } else {
    ({ raw, dir } = readConfigFile(args.config || process.env.HANDSHAKE_CONFIG || 'handshake.config.json'));
  }
  return buildConfig(raw, { baseDir: dir, overrides: { port: args.port, publicUrl: args.publicUrl, dataDir: args.dataDir } });
}

function banner(gw, { adminKeyShown, extra = [] } = {}) {
  const { config } = gw;
  const lines = [
    '',
    `  ${c.b(c.blue('Agent Handshake'))} is running ${c.dim(`(payments: ${config.payments.mode})`)}`,
    '',
    `  Gateway       ${config.publicUrl}`,
    `  My tools      ${config.publicUrl}/my`,
    `  Publisher     ${config.publicUrl}/admin${adminKeyShown ? `   admin key: ${c.b(config.adminKey)}` : c.dim('   (admin key in .handshake/secrets.json)')}`,
    '',
  ];
  for (const s of config.services) {
    lines.push(`  ${c.b(s.title)}`);
    lines.push(`    Install page   ${config.publicUrl}/add/${s.id}`);
    lines.push(`    MCP URL        ${config.publicUrl}/mcp/${s.id}`);
    lines.push(`    Claude Code    ${c.dim(`claude mcp add --transport http ${s.id} ${config.publicUrl}/mcp/${s.id}`)}`);
    lines.push('');
  }
  if (config.local) {
    lines.push(c.dim('  Claude Code, Cursor, VS Code and Goose on this computer can use these URLs as they are.'));
    lines.push(c.dim('  For claude.ai or ChatGPT, give the gateway a public HTTPS URL (see docs/deploy.md).'));
    lines.push('');
  }
  for (const w of config.warnings || []) lines.push(`  ${c.yellow('!')} ${w}`);
  if (config.warnings?.length) lines.push('');
  lines.push(...extra);
  console.log(lines.join('\n'));
}

function onShutdown(fn) {
  let closing = false;
  const handler = async () => {
    if (closing) process.exit(0);
    closing = true;
    await fn();
    process.exit(0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

async function cmdStart(args) {
  const config = loadConfig(args);
  const fresh = !existsSync(resolve(config.dataDir, 'secrets.json'));
  const gw = createGateway(config);
  await gw.listen(config.port, config.host);
  banner(gw, { adminKeyShown: fresh && !process.env.HANDSHAKE_ADMIN_KEY });
  onShutdown(() => gw.close());
}

async function cmdDemo(args) {
  const port = Number(args.port || process.env.PORT || 7410);
  const upstreamPort = Number(args.upstreamPort || port + 1);
  const secret = randomBytes(16).toString('hex');
  const upstream = createDemoUpstream({ secret });
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));
  const raw = demoConfig({ upstreamUrl: `http://127.0.0.1:${upstreamPort}`, secret });
  const config = buildConfig(raw, {
    overrides: { port, publicUrl: args.publicUrl, dataDir: args.dataDir || process.env.DATA_DIR || '.handshake-demo' },
  });
  const gw = createGateway(config);
  await gw.listen(config.port, config.host);
  banner(gw, {
    adminKeyShown: !process.env.HANDSHAKE_ADMIN_KEY,
    extra: [
      c.dim(`  Demo tools run on 127.0.0.1:${upstreamPort} behind the gateway. Data: ${config.dataDir}`),
      `  ${c.green('Start here:')} open ${c.b(`${config.publicUrl}/add/lumen-video`)}`,
      '',
    ],
  });
  onShutdown(async () => {
    await gw.close();
    upstream.close();
  });
}

// For containers: run your config if there is one, otherwise the demo.
async function cmdAuto(args) {
  const hasConfig = args.config || process.env.HANDSHAKE_CONFIG_JSON || existsSync(resolve(process.env.HANDSHAKE_CONFIG || 'handshake.config.json'));
  if (hasConfig) return cmdStart(args);
  console.log(c.yellow('  No config found (HANDSHAKE_CONFIG_JSON or handshake.config.json), so starting the demo.'));
  return cmdDemo(args);
}

async function cmdValidate(args) {
  const config = loadConfig(args);
  console.log(`${c.green('✓')} Config is valid. Public URL: ${config.publicUrl}. Payments: ${config.payments.mode}.`);
  let bad = 0;
  for (const s of config.services) {
    const sum = summarizeTerms(termsExtension(s, config.publicUrl));
    console.log(`\n${c.b(s.title)} (${s.id})`);
    console.log(`  Plans: ${s.plans.map((p) => `${p.title} [${priceLabel(p)}]`).join(', ')}`);
    console.log(`  Consent screen: ${sum.lines.join(' | ')}`);
    try {
      const res = await fetch(s.upstream.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...s.upstream.headers },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-handshake-validate', version: pkg.version } },
        }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.text();
      if (res.ok && body.includes('"result"')) console.log(`  ${c.green('✓')} Upstream answers MCP at ${s.upstream.url}`);
      else if (res.status === 400 && body.includes('-3202')) console.log(`  ${c.green('✓')} Upstream answers (stateless MCP 2026-07-28) at ${s.upstream.url}`);
      else {
        bad++;
        console.log(`  ${c.red('✗')} Upstream returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      bad++;
      console.log(`  ${c.red('✗')} Could not reach ${s.upstream.url}: ${err.cause?.code || err.message}`);
    }
  }
  if (bad) process.exitCode = 1;
}

function findService(config, id) {
  const s = id ? config.services.find((x) => x.id === id) : config.services[0];
  if (!s) throw new ConfigError([`No service "${id}". Services: ${config.services.map((x) => x.id).join(', ')}`]);
  return s;
}

async function cmdLinks(args) {
  const config = loadConfig(args);
  const s = findService(config, args._[1]);
  const mcp = `${config.publicUrl}/mcp/${s.id}`;
  const page = `${config.publicUrl}/add/${s.id}`;
  console.log(`${c.b('Install page')} (put this behind your button)\n  ${page}\n`);
  console.log(`${c.b('HTML button')}\n  <script src="${config.publicUrl}/button.js" data-service="${s.id}" async></script>\n`);
  console.log(`${c.b('README badge (Markdown)')}\n  [![Add to my agent](${config.publicUrl}/badge/${s.id}.svg)](${page})\n`);
  console.log(`${c.b('Direct links per app')}`);
  for (const [k, v] of Object.entries(installLinks({ name: s.id, url: mcp, title: s.title, description: s.description }))) {
    console.log(`  ${k.padEnd(12)} ${v}`);
  }
  console.log(`\n${c.b('MCP URL')}\n  ${mcp}`);
}

async function cmdCard(args) {
  const config = loadConfig(args);
  console.log(JSON.stringify(serverCard(config, findService(config, args._[1])), null, 2));
}

async function cmdInit(args) {
  const file = resolve(args.config || 'handshake.config.json');
  if (existsSync(file) && !args.force) {
    console.error(`${file} already exists. Use --force to overwrite.`);
    process.exit(1);
  }
  const yes = Boolean(args.yes);
  const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    if (yes) return def;
    const a = (await rl.question(`${q}${def !== undefined ? c.dim(` (${def})`) : ''}: `)).trim();
    return a || def;
  };
  console.log(`\n${c.b('Agent Handshake setup')}\nPut your MCP server behind a gateway with a free trial, metering and an uninstall button.\n`);
  const upstream = await ask('URL of your MCP server (Streamable HTTP)', args.upstream || 'http://localhost:3000/mcp');
  const title = await ask('Name people will see', args.title || 'My Tool');
  const id = await ask('Short id for links', args.id || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-tool');
  const domain = await ask('Your domain (shown as the publisher)', args.domain || 'example.com');
  const description = await ask('One-line description', args.description || `${title} for your AI agent.`);
  const trialDays = Number(await ask('Free trial length in days', args.trialDays || '7'));
  const trialCalls = Number(await ask('Calls included in the trial', args.trialCalls || '100'));
  const price = Number(await ask('Monthly price after the trial in USD (0 = no paid plan)', args.price || '9'));
  const authHeader = await ask('Header your MCP server needs from the gateway, e.g. "Authorization" (blank = none)', args.authHeader || '');
  rl?.close();

  const service = {
    id,
    name: `${domain.split('.').reverse().join('.')}/${id}`,
    title,
    description,
    version: '1.0.0',
    publisher: { name: title, domain },
    upstream: { url: upstream, ...(authHeader ? { headers: { [authHeader]: '${env:UPSTREAM_TOKEN}' } } : {}) },
    plans: [
      { id: 'trial', title: 'Free trial', price: 0, durationDays: trialDays, limits: { calls: trialCalls } },
      ...(price > 0 ? [{ id: 'pro', title: 'Pro', price: { amount: price, currency: 'USD', interval: 'month' } }] : []),
    ],
  };
  const cfg = { $schema: 'https://raw.githubusercontent.com/larvuz2/agent-handshake/main/spec/config.schema.json', name: `${title} on Agent Handshake`, services: [service] };
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`\n${c.green('✓')} Wrote ${file}`);
  console.log('\nNext:');
  if (authHeader) console.log(`  export UPSTREAM_TOKEN=...      ${c.dim(`# the value of the ${authHeader} header`)}`);
  console.log('  npx github:larvuz2/agent-handshake validate   # checks your MCP server answers');
  console.log('  npx github:larvuz2/agent-handshake start      # starts the gateway on http://localhost:7410');
  console.log(c.dim('\n  Tip: give tools a scope to lock them to paid plans. See docs/publishers.md.'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) return console.log(pkg.version);
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') return console.log(HELP);
  const commands = { start: cmdStart, demo: cmdDemo, auto: cmdAuto, init: cmdInit, validate: cmdValidate, links: cmdLinks, card: cmdCard };
  if (!commands[cmd]) {
    console.error(`Unknown command "${cmd}".\n${HELP}`);
    process.exit(1);
  }
  await commands[cmd](args);
}

main().catch(fail);
