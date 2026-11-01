#!/usr/bin/env node
// Demo MCP servers for Agent Handshake, with no dependencies.
//   /lumen/mcp  Lumen Video (fictional): prompt -> storyboard -> preview -> 4K render
//   /notes/mcp  Quick Notes: a tiny per-person notes tool
// Nothing real is rendered. Both speak MCP Streamable HTTP in the session-based
// style (2025-06-18 / 2025-11-25) and the stateless style (2026-07-28).
//
// Run alone:  node examples/demo/server.js   (port 7411)

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MODERN = '2026-07-28';

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const noArgs = { type: 'object', properties: {}, additionalProperties: false };

// ---------- Lumen Video ----------

const SHOT_TYPES = ['Wide establishing shot', 'Slow push-in', 'Close-up', 'Over-the-shoulder', 'Aerial pull-back', 'Tracking shot'];

function lumenApp() {
  const byUser = new Map();
  const mine = (user) => (byUser.has(user) ? byUser.get(user) : byUser.set(user, new Map()).get(user));
  return {
    info: { name: 'lumen-video-demo', title: 'Lumen Video (demo)', version: '1.4.0' },
    instructions:
      'Lumen Video turns a prompt into a short video: create a project, render a 480p preview, then render 4K on the Pro plan. Demo server: no real video is rendered.',
    tools: [
      { name: 'list_projects', title: 'List projects', description: 'List your Lumen Video projects.', inputSchema: noArgs, annotations: { readOnlyHint: true } },
      {
        name: 'create_project',
        title: 'Create project',
        description: 'Create a video project from a prompt. Returns a storyboard of shots.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Project title' },
            prompt: { type: 'string', description: 'What the video should show' },
            seconds: { type: 'integer', minimum: 5, maximum: 60, default: 15 },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'render_preview',
        title: 'Render preview',
        description: 'Render a 480p preview of a project.',
        inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
      },
      {
        name: 'render_full',
        title: 'Render 4K',
        description: 'Render the final 4K video of a project (Pro plan).',
        inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
      },
    ],
    call(user, name, args = {}) {
      const list = mine(user);
      if (name === 'list_projects') {
        if (list.size === 0) return text('No projects yet. Create one with create_project.');
        return { ...text([...list.values()].map((p) => `- ${p.id}: ${p.title} (${p.seconds}s, ${p.status})`).join('\n')), structuredContent: { projects: [...list.values()] } };
      }
      if (name === 'create_project') {
        if (!args.prompt) return text('prompt is required', true);
        const seconds = Math.max(5, Math.min(60, Number(args.seconds) || 15));
        const skip = new Set(['over', 'with', 'from', 'into', 'that', 'this', 'your', 'about', 'under', 'after', 'before', 'some', 'very']);
        const words = String(args.prompt).split(/\s+/).filter((w) => w.length > 3 && !skip.has(w.toLowerCase()));
        const n = Math.max(3, Math.min(6, Math.round(seconds / 5)));
        const shots = Array.from({ length: n }, (_, i) => ({
          shot: i + 1,
          seconds: Math.round((seconds / n) * 10) / 10,
          framing: SHOT_TYPES[i % SHOT_TYPES.length],
          subject: words[i % Math.max(1, words.length)] || 'scene',
        }));
        const id = `prj_${String(list.size + 1).padStart(3, '0')}`;
        const p = { id, title: args.title || String(args.prompt).slice(0, 40), prompt: args.prompt, seconds, status: 'draft', shots };
        list.set(id, p);
        return {
          ...text(`Created ${id} "${p.title}" with ${shots.length} shots:\n${shots.map((s) => `  ${s.shot}. ${s.framing} of ${s.subject} (${s.seconds}s)`).join('\n')}`),
          structuredContent: p,
        };
      }
      if (name === 'render_preview' || name === 'render_full') {
        const p = list.get(args.projectId);
        if (!p) return text(`No project ${args.projectId}. Use list_projects to see yours.`, true);
        const full = name === 'render_full';
        p.status = full ? 'rendered' : 'previewed';
        return text(
          `${full ? 'Rendered the 4K video' : 'Rendered a 480p preview'} of ${p.id} (${p.seconds}s, ${p.shots.length} shots).\n` +
            `Demo link: https://lumen.example/${full ? 'video' : 'preview'}/${p.id}.mp4 (demo only, no real file)`,
        );
      }
      return null;
    },
  };
}

// ---------- Quick Notes ----------

function notesApp() {
  const byUser = new Map();
  const mine = (user) => (byUser.has(user) ? byUser.get(user) : byUser.set(user, []).get(user));
  return {
    info: { name: 'quick-notes-demo', title: 'Quick Notes (demo)', version: '0.9.0' },
    instructions: 'Quick Notes keeps short notes for the person. Add, list and search them.',
    tools: [
      {
        name: 'add_note',
        title: 'Add note',
        description: 'Save a short note.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      { name: 'list_notes', title: 'List notes', description: 'List saved notes, newest first.', inputSchema: noArgs, annotations: { readOnlyHint: true } },
      {
        name: 'search_notes',
        title: 'Search notes',
        description: 'Find notes that contain a word.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        annotations: { readOnlyHint: true },
      },
    ],
    call(user, name, args = {}) {
      const notes = mine(user);
      if (name === 'add_note') {
        if (!args.text) return text('text is required', true);
        notes.unshift({ id: notes.length + 1, text: String(args.text).slice(0, 2000), at: new Date().toISOString() });
        return text(`Saved note #${notes.length}.`);
      }
      if (name === 'list_notes') return text(notes.length ? notes.map((n) => `#${n.id} ${n.text}`).join('\n') : 'No notes yet.');
      if (name === 'search_notes') {
        const q = String(args.query || '').toLowerCase();
        const hits = notes.filter((n) => n.text.toLowerCase().includes(q));
        return text(hits.length ? hits.map((n) => `#${n.id} ${n.text}`).join('\n') : `No notes match "${args.query}".`);
      }
      return null;
    },
  };
}

// ---------- World Clock ----------

const CITIES = {
  'new york': 'America/New_York', 'los angeles': 'America/Los_Angeles', 'mexico city': 'America/Mexico_City', 'sao paulo': 'America/Sao_Paulo',
  london: 'Europe/London', paris: 'Europe/Paris', madrid: 'Europe/Madrid', berlin: 'Europe/Berlin', lagos: 'Africa/Lagos', dubai: 'Asia/Dubai',
  mumbai: 'Asia/Kolkata', singapore: 'Asia/Singapore', tokyo: 'Asia/Tokyo', sydney: 'Australia/Sydney', utc: 'UTC',
};
function zoneFor(place) {
  const p = String(place || '').trim();
  if (CITIES[p.toLowerCase()]) return CITIES[p.toLowerCase()];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: p });
    return p;
  } catch {
    return null;
  }
}
const fmtIn = (zone, d = new Date()) => d.toLocaleString('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });

function clockApp() {
  return {
    info: { name: 'world-clock-demo', title: 'World Clock (demo)', version: '1.0.0' },
    instructions: 'Current time in cities and time zones, and meeting times across zones.',
    tools: [
      {
        name: 'time_in',
        title: 'Time in a city',
        description: 'Current local time in a city or IANA time zone (e.g. "Tokyo", "Europe/Paris").',
        inputSchema: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'meeting_times',
        title: 'Meeting time across cities',
        description: 'Show one moment (ISO time, default now) in several cities.',
        inputSchema: { type: 'object', properties: { places: { type: 'array', items: { type: 'string' } }, at: { type: 'string' } }, required: ['places'] },
        annotations: { readOnlyHint: true },
      },
    ],
    call(user, name, args = {}) {
      if (name === 'time_in') {
        const zone = zoneFor(args.place);
        return zone ? text(`${args.place}: ${fmtIn(zone)} (${zone})`) : text(`I don't know "${args.place}". Try a big city or an IANA zone like Europe/Paris.`, true);
      }
      if (name === 'meeting_times') {
        const at = args.at ? new Date(args.at) : new Date();
        if (Number.isNaN(at.getTime())) return text('at must be an ISO date-time', true);
        const rows = (args.places || []).map((p) => {
          const z = zoneFor(p);
          return z ? `- ${p}: ${fmtIn(z, at)}` : `- ${p}: unknown place`;
        });
        return text(rows.join('\n') || 'Give at least one place.');
      }
      return null;
    },
  };
}

// ---------- Text Tools ----------

function textApp() {
  return {
    info: { name: 'text-tools-demo', title: 'Text Tools (demo)', version: '1.0.0' },
    instructions: 'Count words, make URL slugs, and pull out emails and links from text.',
    tools: [
      { name: 'word_count', title: 'Word count', description: 'Count words, characters and reading time.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
      { name: 'slugify', title: 'Slugify', description: 'Turn a title into a URL slug.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
      { name: 'extract_links', title: 'Extract emails and links', description: 'Find every email address and URL in a text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
    ],
    call(user, name, args = {}) {
      const t = String(args.text || '');
      if (name === 'word_count') {
        const words = t.split(/\s+/).filter(Boolean).length;
        return text(`${words} words, ${t.length} characters, about ${Math.max(1, Math.round(words / 230))} min to read.`);
      }
      if (name === 'slugify') return text(t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '(empty)');
      if (name === 'extract_links') {
        const emails = t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
        const urls = t.match(/https?:\/\/[^\s)]+/g) || [];
        return text(`Emails: ${emails.join(', ') || 'none'}\nLinks: ${urls.join(', ') || 'none'}`);
      }
      return null;
    },
  };
}

// ---------- Unit Converter ----------

const UNITS = {
  m: ['length', 1], km: ['length', 1000], cm: ['length', 0.01], mm: ['length', 0.001], mi: ['length', 1609.344], ft: ['length', 0.3048], in: ['length', 0.0254], yd: ['length', 0.9144],
  kg: ['mass', 1], g: ['mass', 0.001], lb: ['mass', 0.45359237], oz: ['mass', 0.028349523125],
  l: ['volume', 1], ml: ['volume', 0.001], gal: ['volume', 3.785411784], cup: ['volume', 0.2365882365],
};
function unitsApp() {
  return {
    info: { name: 'unit-converter-demo', title: 'Unit Converter (demo)', version: '1.0.0' },
    instructions: 'Convert length, weight, volume and temperature.',
    tools: [
      {
        name: 'convert',
        title: 'Convert units',
        description: 'Convert a value, e.g. 5 mi to km, 70 F to C, 2 lb to g.',
        inputSchema: { type: 'object', properties: { value: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['value', 'from', 'to'] },
        annotations: { readOnlyHint: true },
      },
    ],
    call(user, name, args = {}) {
      if (name !== 'convert') return null;
      const v = Number(args.value);
      const from = String(args.from || '').toLowerCase();
      const to = String(args.to || '').toLowerCase();
      const temp = { c: (x) => x, f: (x) => ((x - 32) * 5) / 9, k: (x) => x - 273.15 };
      const fromC = { c: (x) => x, f: (x) => (x * 9) / 5 + 32, k: (x) => x + 273.15 };
      let out;
      if (temp[from] && fromC[to]) out = fromC[to](temp[from](v));
      else if (UNITS[from] && UNITS[to] && UNITS[from][0] === UNITS[to][0]) out = (v * UNITS[from][1]) / UNITS[to][1];
      else return text(`Can't convert ${from} to ${to}. Known: ${Object.keys(UNITS).join(', ')}, c, f, k.`, true);
      return text(`${v} ${args.from} = ${Math.round(out * 10000) / 10000} ${args.to}`);
    },
  };
}

// ---------- MCP plumbing ----------

function handleMessage(app, user, msg) {
  const modern = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === MODERN;
  const done = (result) => ({ jsonrpc: '2.0', id: msg.id, result: modern ? { resultType: 'complete', ...result } : result });
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: app.info,
          instructions: app.instructions,
        },
      };
    }
    case 'server/discover':
      return done({
        supportedVersions: [MODERN, ...LEGACY_VERSIONS],
        capabilities: { tools: {} },
        instructions: app.instructions,
        ttlMs: 3600000,
        cacheScope: 'public',
        _meta: { 'io.modelcontextprotocol/serverInfo': app.info },
      });
    case 'ping':
      return done({});
    case 'tools/list':
      return done(modern ? { tools: app.tools, ttlMs: 3600000, cacheScope: 'public' } : { tools: app.tools });
    case 'tools/call': {
      const r = app.call(user, msg.params?.name, msg.params?.arguments);
      if (!r) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } };
      return done(r);
    }
    default:
      if (msg.id === undefined) return null; // notification
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.secret] require this value in the x-upstream-secret header
 * @param {boolean} [opts.sse] answer POSTs as an SSE stream instead of JSON
 */
export function createDemoUpstream({ secret, sse = false } = {}) {
  const apps = { lumen: lumenApp(), notes: notesApp(), clock: clockApp(), text: textApp(), units: unitsApp() };
  const sessions = new Set();

  return createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const m = /^\/(\w+)\/mcp$/.exec(path);
    const key = path === '/mcp' ? 'lumen' : m && apps[m[1]] ? m[1] : null;
    if (!key) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(`Agent Handshake demo MCP servers: POST ${Object.keys(apps).map((k) => `/${k}/mcp`).join(', ')}`);
    }
    if (secret && req.headers['x-upstream-secret'] !== secret) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing or wrong x-upstream-secret' }));
    }
    if (req.method === 'GET') {
      res.writeHead(405, { allow: 'POST, DELETE' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      sessions.delete(req.headers['mcp-session-id']);
      res.writeHead(200);
      return res.end();
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    let body = '';
    for await (const c of req) body += c;
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    }
    // Behind Agent Handshake, the gateway says who is calling.
    const user = String(req.headers['x-handshake-user'] || 'anonymous');
    const msgs = Array.isArray(msg) ? msg : [msg];
    const headers = {};
    if (msgs.some((m) => m.method === 'initialize')) {
      const sid = randomUUID();
      sessions.add(sid);
      headers['mcp-session-id'] = sid;
    }
    const out = msgs.map((m) => handleMessage(apps[key], user, m)).filter(Boolean);
    if (out.length === 0) {
      res.writeHead(202, headers);
      return res.end();
    }
    const payload = Array.isArray(msg) ? out : out[0];
    if (sse) {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': demo stream\n\n');
      for (const m of [].concat(payload)) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
}

// The gateway config that puts both demo servers behind Agent Handshake.
export function demoConfig({ upstreamUrl = 'http://localhost:7411', secret } = {}) {
  const headers = secret ? { 'x-upstream-secret': secret } : {};
  return {
    name: 'Agent Handshake',
    services: [
      {
        id: 'lumen-video',
        name: 'com.lumenvideo/mcp',
        title: 'Lumen Video',
        description: 'Turn a prompt into a short video: storyboards, previews and 4K renders.',
        version: '1.4.0',
        publisher: { name: 'Lumen Labs (demo)', domain: 'lumen.example' },
        tags: ['video', 'creative', 'media'],
        upstream: { url: `${upstreamUrl}/lumen/mcp`, headers },
        scopes: {
          projects: { description: 'Create and read your video projects', tools: ['list_projects', 'create_project'] },
          'render:preview': { description: 'Render 480p previews', tools: ['render_preview'] },
          'render:full': { description: 'Render full-quality 4K videos', tools: ['render_full'] },
        },
        plans: [
          { id: 'trial', title: 'Free trial', price: 0, durationDays: 7, limits: { calls: 100 }, scopes: ['projects', 'render:preview'] },
          { id: 'pro', title: 'Pro', price: { amount: 9, currency: 'USD', interval: 'month' }, scopes: ['projects', 'render:preview', 'render:full'] },
          { id: 'free', title: 'Free', price: 0, limits: { calls: 20, period: 'month' }, scopes: ['projects'] },
        ],
      },
      {
        id: 'quick-notes',
        name: 'dev.quicknotes/mcp',
        title: 'Quick Notes',
        description: 'Short notes your agent can save, list and search.',
        version: '0.9.0',
        publisher: { name: 'Quick Notes (demo)', domain: 'quicknotes.example' },
        tags: ['notes', 'memory', 'productivity'],
        upstream: { url: `${upstreamUrl}/notes/mcp`, headers },
        plans: [{ id: 'free', title: 'Free', price: 0, limits: { calls: 200, period: 'day' } }],
      },
      {
        id: 'world-clock',
        name: 'dev.worldclock/mcp',
        title: 'World Clock',
        description: 'Local time anywhere, and meeting times across time zones.',
        version: '1.0.0',
        publisher: { name: 'World Clock (demo)', domain: 'worldclock.example' },
        tags: ['time', 'timezone', 'meetings', 'calendar'],
        upstream: { url: `${upstreamUrl}/clock/mcp`, headers },
        plans: [{ id: 'free', title: 'Free', price: 0 }],
      },
      {
        id: 'text-tools',
        name: 'dev.texttools/mcp',
        title: 'Text Tools',
        description: 'Word counts, URL slugs, and emails and links pulled out of any text.',
        version: '1.0.0',
        publisher: { name: 'Text Tools (demo)', domain: 'texttools.example' },
        tags: ['text', 'writing', 'seo'],
        upstream: { url: `${upstreamUrl}/text/mcp`, headers },
        plans: [
          { id: 'trial', title: 'Free trial', price: 0, durationDays: 14, limits: { calls: 300 } },
          { id: 'pro', title: 'Pro', price: { amount: 3, currency: 'USD', interval: 'month' } },
        ],
      },
      {
        id: 'unit-converter',
        name: 'dev.units/mcp',
        title: 'Unit Converter',
        description: 'Convert length, weight, volume and temperature.',
        version: '1.0.0',
        publisher: { name: 'Unit Converter (demo)', domain: 'units.example' },
        tags: ['math', 'units', 'convert', 'cooking'],
        upstream: { url: `${upstreamUrl}/units/mcp`, headers },
        plans: [{ id: 'free', title: 'Free', price: 0, limits: { calls: 100, period: 'day' } }],
      },
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 7411);
  createDemoUpstream({ secret: process.env.DEMO_UPSTREAM_SECRET }).listen(port, () => {
    console.log(`Demo MCP servers on http://localhost:${port}/lumen/mcp and /notes/mcp`);
  });
}
