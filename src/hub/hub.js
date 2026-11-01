// The hub: one MCP connection that gives an agent every tool on this gateway.
//
// The agent connects once to /mcp. From then on it can:
//   handshake_search     find tools for a job
//   handshake_add        add one (free trials start on their own, if the person allows)
//   handshake_call       run an action of an added tool right away
//   handshake_tool_info  see a tool's actions and inputs
//   handshake_my_tools   see plans, usage and the manage link
//   handshake_upgrade    get the link where the person picks a plan
//   handshake_remove     remove a tool
// Added tools also appear as their own tools, named <tool>__<action>.
// Every call goes through the same plan checks and metering as a direct connection.

import { randomUUID } from 'node:crypto';
import { readBody, send, sendJson, CORS_HEADERS } from '../util/http.js';
import { daysLeft } from '../entitlements.js';
import { labelFromDays, windowStats } from '../labels.js';
import { defaultPlan, isFree, isTrial, planAllowsTool, planById, priceLabel, summarizeTerms, termsExtension, upgradePlans } from '../terms.js';
import { PAYMENT_RESPONSE_META } from '../billing/x402.js';
import { rpcError, rpcResult } from '../mcp/proxy.js';
import { HUB_ID } from './identity.js';
import { UpstreamClient, UpstreamError } from './upstream.js';

const SEP = '__';
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'can', 'you', 'make', 'need', 'want', 'some', 'tool', 'tools', 'that', 'this', 'from', 'into', 'about', 'please', 'help']);
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

const toolArg = { type: 'string', description: 'The tool id from handshake_search, e.g. "lumen-video"' };
export const META_TOOLS = [
  {
    name: 'handshake_search',
    title: 'Find tools',
    description:
      'Search the tools you can add through Agent Handshake. Use it when the person asks for something you cannot do yet. ' +
      'Returns each tool id, what it does, its free trial or price, and whether it is already added. Leave query empty to list everything.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What the person needs, e.g. "make a video" or "notes"' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'handshake_add',
    title: 'Add a tool',
    description:
      'Add a tool so you can use it. Free trials and free plans start right away if the person allows it; otherwise you get a link for the person. ' +
      'Returns the tool actions, which you can run at once with handshake_call.',
    inputSchema: { type: 'object', properties: { tool: toolArg }, required: ['tool'], additionalProperties: false },
  },
  {
    name: 'handshake_call',
    title: 'Use a tool',
    description:
      'Run an action of an added tool. Use it right after handshake_add. The actions also show up as their own tools (named tool__action) once your app refreshes its tool list.',
    inputSchema: {
      type: 'object',
      properties: { tool: toolArg, action: { type: 'string', description: 'Action name from handshake_add or handshake_tool_info' }, arguments: { type: 'object', description: 'Inputs for the action' } },
      required: ['tool', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'handshake_tool_info',
    title: 'Tool details',
    description: 'Show a tool: its plans and its actions with their inputs.',
    inputSchema: { type: 'object', properties: { tool: toolArg }, required: ['tool'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'handshake_my_tools',
    title: 'My tools',
    description: "List the person's tools with plan, days left, calls used and a usage label, plus a link where they can manage them.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'handshake_upgrade',
    title: 'Upgrade link',
    description: 'Get the link where the person can upgrade a tool or switch plans. Payment always happens on that page, never in the chat.',
    inputSchema: { type: 'object', properties: { tool: toolArg, plan: { type: 'string', description: 'Optional plan id, e.g. "pro"' } }, required: ['tool'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'handshake_remove',
    title: 'Remove a tool',
    description: 'Remove a tool. Its access ends at once. Only do this when the person asks.',
    inputSchema: { type: 'object', properties: { tool: toolArg }, required: ['tool'], additionalProperties: false },
    annotations: { destructiveHint: true },
  },
];
const META_NAMES = new Set(META_TOOLS.map((t) => t.name));

export function hubInstructions(config) {
  return (
    `${config.name} gives you many tools through this one connection. ` +
    'When the person asks for something you cannot do, call handshake_search, then handshake_add, then use the tool (handshake_call works right away). ' +
    'Free trials start on their own within the limits the person set. Paid plans always need the person: give them the link from handshake_upgrade.'
  );
}

const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });
const errorText = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

export class Hub {
  constructor({ config, services, oauth, entitlements, users, store, x402, proxy, checkout, log }) {
    Object.assign(this, { config, services, oauth, entitlements, users, store, x402, proxy, checkout, log });
    this.clients = new Map();
  }

  client(service) {
    if (!this.clients.has(service.id)) this.clients.set(service.id, new UpstreamClient(service, { log: this.log }));
    return this.clients.get(service.id);
  }

  findService(ref) {
    if (!ref) return null;
    const r = String(ref).trim().toLowerCase();
    return this.services.get(r) || [...this.services.values()].find((s) => s.title.toLowerCase() === r || s.name.toLowerCase() === r) || null;
  }

  active(userId, serviceId) {
    const e = this.entitlements.current(userId, serviceId);
    return e && e.status !== 'dropped' ? e : null;
  }

  // ---------- HTTP ----------

  async handle(req, res) {
    const auth = this.oauth.authenticateRequest(req, HUB_ID);
    if (!auth.user) {
      return sendJson(
        res,
        401,
        { error: auth.error?.code || 'unauthorized', error_description: auth.error?.description || `Connect ${this.config.name} to use it` },
        { ...CORS_HEADERS, 'www-authenticate': this.oauth.wwwAuthenticate(HUB_ID, auth.error) },
      );
    }
    if (req.method === 'GET') return send(res, 405, '', { ...CORS_HEADERS, allow: 'POST, DELETE' });
    if (req.method === 'DELETE') return send(res, 200, '', CORS_HEADERS);
    if (req.method !== 'POST') return send(res, 405, '', { ...CORS_HEADERS, allow: 'POST, DELETE' });

    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, 'Parse error'), CORS_HEADERS);
    }
    const msgs = (Array.isArray(body) ? body : [body]).filter((m) => m && typeof m === 'object');
    const ids = msgs.filter((m) => m.method && m.id !== undefined).map((m) => `${typeof m.id}:${m.id}`);
    if (msgs.some((m) => m.method && m.id !== undefined && !(typeof m.id === 'string' || Number.isInteger(m.id))) || new Set(ids).size !== ids.length) {
      return sendJson(res, 400, rpcError(null, -32600, 'Request ids must be unique strings or integers'), CORS_HEADERS);
    }

    const ctx = { grant: auth.grant, user: auth.user, headers: { ...CORS_HEADERS }, changed: false };
    const out = [];
    for (const m of msgs) {
      this.proxy.rememberClient(ctx.grant, m);
      const r = await this.dispatch(ctx, m);
      if (r) out.push(r);
    }
    if (out.length === 0) return send(res, 202, '', ctx.headers);
    const payload = Array.isArray(body) ? out : out[0];

    // When the tool list changed (a tool was added or removed), session-based clients
    // get a list_changed notification in the same response stream, so they refresh.
    const legacy = !msgs.some((m) => m.params?._meta?.[META_VERSION]);
    if (ctx.changed && legacy && String(req.headers.accept || '').includes('text/event-stream')) {
      res.writeHead(200, { ...ctx.headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
      for (const m of [].concat(payload)) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
      return res.end();
    }
    return sendJson(res, 200, payload, ctx.headers);
  }

  async dispatch(ctx, msg) {
    const modern = Boolean(msg.params?._meta?.[META_VERSION]);
    const done = (result) => rpcResult(msg.id, modern ? { resultType: 'complete', ...result } : result);
    if (msg.id === undefined) return null; // notification
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        ctx.headers['mcp-session-id'] = randomUUID();
        return rpcResult(msg.id, {
          protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'agent-handshake-hub', title: this.config.name, version: '0.2.0' },
          instructions: hubInstructions(this.config),
        });
      }
      case 'server/discover':
        return done({
          supportedVersions: ['2026-07-28', ...LEGACY_VERSIONS],
          capabilities: { tools: { listChanged: true } },
          instructions: hubInstructions(this.config),
          ttlMs: 60000,
          cacheScope: 'private',
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'agent-handshake-hub', title: this.config.name, version: '0.2.0' } },
        });
      case 'ping':
        return done({});
      case 'tools/list': {
        const tools = [...META_TOOLS, ...(await this.addedTools(ctx))];
        return done(modern ? { tools, ttlMs: 60000, cacheScope: 'private' } : { tools });
      }
      case 'tools/call':
        return this.callTool(ctx, msg, done);
      case 'resources/list':
        return done({ resources: [] });
      case 'resources/templates/list':
        return done({ resourceTemplates: [] });
      case 'prompts/list':
        return done({ prompts: [] });
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  // Actions of every tool the person has added, as tool__action.
  async addedTools(ctx) {
    const ents = this.entitlements.forUser(ctx.user.id).filter((e) => e.status === 'trial' || e.status === 'active');
    const lists = await Promise.all(
      ents.map(async (e) => {
        const service = this.services.get(e.serviceId);
        if (!service) return [];
        try {
          const plan = { ...(planById(service, e.planId) || {}), scopes: e.scopes };
          const tools = await this.client(service).listTools(this.identity(service, e, ctx));
          return tools
            .filter((t) => planAllowsTool(service, plan, t.name))
            .map((t) => ({
              ...t,
              name: `${service.id}${SEP}${t.name}`.slice(0, 128),
              title: `${service.title}: ${t.title || t.name}`,
              description: `[${service.title}] ${t.description || ''}`.trim(),
            }));
        } catch (err) {
          this.log?.warn?.(`[hub] could not list ${service.id}: ${err.message}`);
          return [];
        }
      }),
    );
    return lists.flat();
  }

  identity(service, e, ctx) {
    return this.proxy.identityHeaders({ service, entitlement: e, grant: ctx.grant });
  }

  async callTool(ctx, msg, done) {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    if (META_NAMES.has(name)) {
      try {
        return done(await this[`meta_${name.slice('handshake_'.length)}`](ctx, args, msg));
      } catch (err) {
        this.log?.error?.(`[hub] ${name}: ${err.stack || err.message}`);
        return done(errorText(`Something went wrong: ${err.message}`));
      }
    }
    const i = String(name || '').indexOf(SEP);
    if (i < 1) return done(errorText(`Unknown tool "${name}". Use handshake_search to find tools.`));
    return this.callService(ctx, msg, name.slice(0, i), name.slice(i + SEP.length), args, msg.params?._meta, done);
  }

  // Run one action of one tool, with the same checks and metering as a direct connection.
  async callService(ctx, msg, serviceRef, action, args, meta, done) {
    const service = this.findService(serviceRef);
    if (!service) return done(errorText(`No tool called "${serviceRef}". Use handshake_search to find tools.`));
    const e = this.active(ctx.user.id, service.id);
    if (!e) return done(errorText(`${service.title} isn't added yet. Call handshake_add with {"tool":"${service.id}"} first.`));

    const sctx = this.proxy.context(service, { entitlement: e, grant: ctx.grant });
    const inner = { jsonrpc: '2.0', id: msg.id, method: 'tools/call', params: { name: action, arguments: args, ...(meta ? { _meta: meta } : {}) } };
    const d = await this.proxy.decide(sctx, inner);
    if (d.local) return d.local;

    const params = (d.body || inner).params;
    const { _meta: _m, ...forward } = params;
    void _m;
    let reply;
    try {
      reply = await this.client(service).request('tools/call', forward, this.identity(service, e, ctx));
    } catch (err) {
      this.entitlements.release(e, d.costUsd);
      return done(errorText(`${service.title} is not reachable right now (${err instanceof UpstreamError ? err.message : 'error'}).`));
    }
    let ok = !reply.error && !reply.result?.isError;
    let out = reply.error ? rpcError(msg.id, reply.error.code, reply.error.message, reply.error.data) : rpcResult(msg.id, reply.result);
    let costUsd = 0;
    if (d.payment && ok) {
      out = await this.x402.settle(sctx, d, out);
      if (out.result?._meta?.[PAYMENT_RESPONSE_META]?.success) costUsd = d.costUsd;
      else ok = false;
    }
    this.entitlements.record(e, {
      tool: action,
      ok,
      latencyMs: Date.now() - d.started,
      costUsd,
      reservedUsd: d.costUsd,
      client: ctx.grant.clientInfo?.name || ctx.grant.clientName,
    });
    if (out.result && msg.params?._meta?.[META_VERSION] && !out.result.resultType) out.result.resultType = 'complete';
    return out;
  }

  // ---------- agent tools ----------

  describe(service, userId) {
    const terms = termsExtension(service, this.config.publicUrl);
    const sum = summarizeTerms(terms);
    const e = userId ? this.entitlements.current(userId, service.id) : null;
    let status = 'not added';
    if (e && (e.status === 'trial' || e.status === 'active')) {
      const left = daysLeft(e);
      status = `added (${planById(service, e.planId)?.title || e.planId}${left !== null ? `, ${left} days left` : ''})`;
    } else if (e && e.status === 'expired') status = 'plan ended';
    else if (e && e.status === 'dropped') status = 'removed';
    const paid = upgradePlans(service).map((p) => `${p.title} ${priceLabel(p)}`);
    return {
      id: service.id,
      title: service.title,
      description: service.description,
      tags: service.tags,
      startsWith: sum.duration,
      canAccess: sum.access,
      paidPlans: paid,
      status,
    };
  }

  async meta_search(ctx, args) {
    const q = String(args.query || '').toLowerCase().trim();
    const words = q.split(/[^a-z0-9áéíóúñü]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
    const scored = [...this.services.values()]
      .map((s) => {
        if (!words.length) return { s, score: 1 };
        const hay = {
          title: s.title.toLowerCase(),
          tags: (s.tags || []).join(' ').toLowerCase(),
          rest: `${s.description} ${Object.values(s.scopes).map((x) => x.description).join(' ')}`.toLowerCase(),
        };
        let score = 0;
        for (const w of words) {
          const stem = w.length > 4 ? w.replace(/(ing|es|s)$/, '') : w;
          if (hay.title.includes(stem)) score += 3;
          if (hay.tags.includes(stem)) score += 2;
          if (hay.rest.includes(stem)) score += 1;
        }
        return { s, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    if (!scored.length) {
      return text(`No tools match "${args.query}". Call handshake_search with an empty query to see all ${this.services.size} tools.`, { structuredContent: { tools: [] } });
    }
    const tools = scored.map(({ s }) => this.describe(s, ctx.user.id));
    const lines = tools.map(
      (t, i) =>
        `${i + 1}. ${t.title} (${t.id}): ${t.description}\n   Starts: ${t.startsWith}.${t.paidPlans.length ? ` Paid: ${t.paidPlans.join(', ')}.` : ''}\n   Status: ${t.status}.`,
    );
    const head = words.length ? `${tools.length} tool${tools.length === 1 ? '' : 's'} for "${args.query}":` : `All ${tools.length} tools:`;
    return text(`${head}\n${lines.join('\n')}\n\nAdd one with handshake_add {"tool":"<id>"}.`, { structuredContent: { tools } });
  }

  async actionsOf(service, e, ctx) {
    try {
      const plan = { ...(planById(service, e.planId) || {}), scopes: e.scopes };
      const tools = await this.client(service).listTools(this.identity(service, e, ctx));
      return tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema, included: planAllowsTool(service, plan, t.name) }));
    } catch (err) {
      return { error: err.message };
    }
  }

  formatActions(service, actions) {
    if (actions.error) return `(Could not load ${service.title}'s actions: ${actions.error})`;
    const inc = actions.filter((a) => a.included);
    const locked = actions.filter((a) => !a.included);
    let out = `Actions (run with handshake_call {"tool":"${service.id}","action":"<name>","arguments":{...}}):\n`;
    out += inc.map((a) => `- ${a.name}: ${a.description}${a.inputSchema?.properties ? ` Inputs: ${Object.keys(a.inputSchema.properties).join(', ')}.` : ''}`).join('\n');
    if (locked.length) out += `\nNeeds an upgrade: ${locked.map((a) => a.name).join(', ')}.`;
    return out;
  }

  async meta_add(ctx, args) {
    const service = this.findService(args.tool);
    if (!service) return errorText(`No tool called "${args.tool}". Use handshake_search to find tools.`);
    const user = ctx.user;
    const existing = this.active(user.id, service.id);
    if (existing && existing.status !== 'expired') {
      const actions = await this.actionsOf(service, existing, ctx);
      return text(`${service.title} is already added.\n${this.formatActions(service, actions)}`);
    }
    const plan = defaultPlan(service);
    const allowed = user.agentCanStartTrials !== false;
    if (!existing && (!allowed || !isFree(plan))) {
      const link = `${this.config.publicUrl}/hub/add/${service.id}?t=${encodeURIComponent(this.users.addToken(user.id, service.id))}`;
      const why = !isFree(plan) ? `${service.title} starts on a paid plan (${priceLabel(plan)})` : 'The person asked to approve new tools themselves';
      return text(`${why}. Show the person this link to add it (it opens in their browser):\n${link}`);
    }
    let e;
    try {
      ({ entitlement: e } = this.entitlements.connect(user.id, service.id));
    } catch (err) {
      return errorText(err.message);
    }
    ctx.changed = true;
    if (e.status === 'expired') {
      const sctx = this.proxy.context(service, { entitlement: e, grant: ctx.grant });
      return text(`${service.title}'s free trial already ended. Show the person this link to pick a plan:\n${sctx.links.upgradeAny()}`);
    }
    const sum = summarizeTerms(termsExtension(service, this.config.publicUrl), e.planId);
    const actions = await this.actionsOf(service, e, ctx);
    this.log?.info?.(`[hub] ${user.id} added ${service.id} (${e.planId})`);
    return text(
      `Added ${service.title}: ${sum.duration}. ${sum.spend}\n${this.formatActions(service, actions)}\n` +
        `They also appear as tools named ${service.id}${SEP}<action> once your app refreshes its tool list.`,
      { structuredContent: { tool: service.id, plan: e.planId, actions: Array.isArray(actions) ? actions.filter((a) => a.included).map((a) => a.name) : [] } },
    );
  }

  async meta_call(ctx, args, msg) {
    const r = await this.callService(ctx, msg, args.tool, args.action, args.arguments || {}, msg.params?._meta, (x) => rpcResult(msg.id, x));
    return r.result || errorText(r.error?.message || 'The tool returned an error');
  }

  async meta_tool_info(ctx, args) {
    const service = this.findService(args.tool);
    if (!service) return errorText(`No tool called "${args.tool}".`);
    const info = this.describe(service, ctx.user.id);
    const e = this.active(ctx.user.id, service.id);
    const plans = service.plans.map((p) => `- ${p.title} (${p.id}): ${priceLabel(p)}${isTrial(p) ? ', starts automatically' : ''}`).join('\n');
    let out = `${service.title} (${service.id}): ${service.description}\nStatus: ${info.status}.\nPlans:\n${plans}`;
    if (e) {
      const actions = await this.actionsOf(service, e, ctx);
      out += `\n${this.formatActions(service, actions)}`;
      if (Array.isArray(actions)) out += `\n\nInput schemas:\n${JSON.stringify(Object.fromEntries(actions.filter((a) => a.included).map((a) => [a.name, a.inputSchema])), null, 1)}`;
    } else {
      out += `\nAdd it with handshake_add {"tool":"${service.id}"} to see and run its actions.`;
    }
    return text(out);
  }

  async meta_my_tools(ctx) {
    const ents = this.entitlements.forUser(ctx.user.id).filter((e) => e.status !== 'dropped' && this.services.get(e.serviceId));
    const manage = `${this.config.publicUrl}/my/login?t=${encodeURIComponent(this.users.loginToken(ctx.user.id, 3600))}`;
    if (!ents.length) return text(`No tools added yet. Use handshake_search to find some.\nManage: ${manage}`);
    const lines = ents.map((e) => {
      const s = this.services.get(e.serviceId);
      const plan = planById(s, e.planId);
      const w7 = windowStats(this.store.usageDays(e.id), Date.now(), 7);
      const lab = labelFromDays(this.store.usageDays(e.id), e.startedAt);
      const left = daysLeft(e);
      const when = e.status === 'expired' ? 'ended' : left !== null ? `${left} days left` : 'ongoing';
      const calls = e.limits.calls !== undefined ? `${e.period.calls}/${e.limits.calls} calls` : `${e.totals.calls} calls`;
      return `- ${s.title} (${s.id}): ${plan?.title || e.planId}, ${when}, ${calls}, ${w7.calls} this week, ${lab.text}`;
    });
    return text(`${lines.join('\n')}\n\nThe person can upgrade or remove tools here (opens in their browser): ${manage}`);
  }

  async meta_upgrade(ctx, args) {
    const service = this.findService(args.tool);
    if (!service) return errorText(`No tool called "${args.tool}".`);
    const e = this.active(ctx.user.id, service.id);
    if (!e) return errorText(`${service.title} isn't added. Use handshake_add first.`);
    const sctx = this.proxy.context(service, { entitlement: e, grant: ctx.grant });
    const plans = upgradePlans(service).filter((p) => p.id !== e.planId);
    if (!plans.length) return text(`${service.title} has no other plans.`);
    const chosen = args.plan ? plans.filter((p) => p.id === args.plan) : plans;
    return text(
      `Show the person ${chosen.length > 1 ? 'these links' : 'this link'} (payment happens on the page, never in chat):\n` +
        chosen.map((p) => `- ${p.title} (${priceLabel(p)}): ${sctx.links.upgrade(p.id)}`).join('\n'),
    );
  }

  async meta_remove(ctx, args) {
    const service = this.findService(args.tool);
    if (!service) return errorText(`No tool called "${args.tool}".`);
    const e = this.active(ctx.user.id, service.id);
    if (!e) return text(`${service.title} isn't added.`);
    await this.checkout.cancel(e);
    this.entitlements.drop(e.id, 'person');
    ctx.changed = true;
    return text(`Removed ${service.title}. Its access ended.`);
  }
}
