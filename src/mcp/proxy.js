// The gateway in front of an MCP server (Streamable HTTP).
// It is a transparent proxy except for three methods:
//   initialize  -> remembers which app connected (older, session-based clients)
//   tools/list  -> hides tools the plan doesn't include, adds handshake_status
//   tools/call  -> checks the entitlement, meters the call, may ask for payment
//
// Works with both MCP eras:
//   2025-06-18 / 2025-11-25: initialize + Mcp-Session-Id. Upgrade prompts use the
//     -32042 URL elicitation error when the client supports it.
//   2026-07-28 (stateless): per-request _meta. Upgrade prompts use an
//     input_required result with a URL-mode elicitation.

import { Readable } from 'node:stream';
import { readBody, send, sendJson, CORS_HEADERS } from '../util/http.js';
import { sign, verify } from '../util/crypto.js';
import { planAllowsTool, planById } from '../terms.js';
import { PAYMENT_META, PAYMENT_RESPONSE_META } from '../billing/x402.js';
import { blockedMessage, STATUS_TOOL, statusText, statusToolDefinition } from './messages.js';
import { parseSseMessages, transformSse } from './sse.js';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_CLIENT = 'io.modelcontextprotocol/clientInfo';
const URL_ELICITATION_REQUIRED = -32042; // 2025-11-25 only
// Methods that still work after a plan ends: lifecycle, discovery and listings.
const OPEN_METHODS = new Set([
  'initialize', 'ping', 'server/discover', 'tools/list', 'resources/list', 'resources/templates/list',
  'prompts/list', 'logging/setLevel', 'subscriptions/listen',
]);
const STATE_PREFIX = 'ahs.';

export class McpProxy {
  constructor({ config, services, oauth, entitlements, users, store, x402, log }) {
    Object.assign(this, { config, services, oauth, entitlements, users, store, x402, log });
  }

  async handle(req, res, serviceId) {
    const service = this.services.get(serviceId);
    if (!service) return sendJson(res, 404, { error: 'not_found', error_description: `No tool called ${serviceId} on this gateway` }, CORS_HEADERS);

    const auth = this.oauth.authenticateRequest(req, serviceId);
    if (!auth.entitlement) {
      return sendJson(
        res,
        401,
        { error: auth.error?.code || 'unauthorized', error_description: auth.error?.description || 'Sign in to use this tool' },
        { ...CORS_HEADERS, 'www-authenticate': this.oauth.wwwAuthenticate(serviceId, auth.error) },
      );
    }
    this.entitlements.refresh(auth.entitlement);
    const ctx = this.context(service, auth);

    if (req.method === 'GET' || req.method === 'DELETE') return this.passthrough(req, res, ctx);
    if (req.method !== 'POST') return send(res, 405, '', { ...CORS_HEADERS, allow: 'GET, POST, DELETE' });

    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, 'Parse error'), CORS_HEADERS);
    }

    const msgs = (Array.isArray(body) ? body : [body]).filter((m) => m && typeof m === 'object');
    for (const m of msgs) this.rememberClient(ctx.grant, m);
    const calls = msgs.filter((m) => m.method === 'tools/call');

    // Requests are matched to responses by id, so ids must be plain and unique.
    const requests = msgs.filter((m) => m.method && m.id !== undefined);
    const badId = requests.find((m) => !(typeof m.id === 'string' || Number.isInteger(m.id)));
    const ids = requests.map((m) => `${typeof m.id}:${m.id}`);
    if (badId || new Set(ids).size !== ids.length) {
      return sendJson(res, 400, rpcError(null, -32600, badId ? 'Request ids must be strings or integers' : 'Request ids in a batch must be unique'), CORS_HEADERS);
    }

    // A plan that ended (or was removed) only keeps the basics: discovery, listing,
    // and tools/call, which explains how to upgrade.
    if (ctx.entitlement.status === 'expired' || ctx.entitlement.status === 'dropped') {
      const blocked = requests.filter((m) => m.method !== 'tools/call' && !OPEN_METHODS.has(m.method));
      if (blocked.length) {
        const text = blockedMessage(ctx.entitlement.status, ctx);
        const out = blocked.map((m) => rpcError(m.id, -32001, text.split('\n')[0], { manage: ctx.links.manage() }));
        return sendJson(res, 200, Array.isArray(body) ? out : out[0], CORS_HEADERS);
      }
    }

    if (calls.length === 0) {
      const lists = msgs.filter((m) => m.method === 'tools/list').map((m) => m.id);
      return this.forward(req, res, ctx, raw, lists.length ? { listIds: new Set(lists) } : null);
    }

    // tools/call: decide locally first.
    const decisions = [];
    for (const m of calls) decisions.push(await this.decide(ctx, m));
    if (!Array.isArray(body)) {
      const d = decisions[0];
      if (d.local) return sendJson(res, 200, d.local, CORS_HEADERS);
      return this.forward(req, res, ctx, d.body ? Buffer.from(JSON.stringify(d.body)) : raw, { calls: new Map([[d.id, d]]) });
    }
    // JSON-RPC batch (2025-03-26 clients). If any call is answered locally, answer the batch locally.
    if (decisions.some((d) => d.local)) {
      const out = msgs
        .filter((m) => m.id !== undefined)
        .map((m) => {
          const d = decisions.find((x) => x.id === m.id);
          if (d?.local) return d.local;
          if (d) this.entitlements.release(ctx.entitlement, d.costUsd);
          return rpcError(m.id, -32600, 'Send this request on its own; the gateway could not process it in a batch.');
        });
      return sendJson(res, 200, out, CORS_HEADERS);
    }
    const forwarded = Array.isArray(body) ? body.map((m) => decisions.find((d) => d.id === m?.id && m?.method === 'tools/call')?.body || m) : body;
    return this.forward(req, res, ctx, Buffer.from(JSON.stringify(forwarded)), { calls: new Map(decisions.map((d) => [d.id, d])) });
  }

  context(service, auth) {
    const { entitlement, grant } = auth;
    const base = this.config.publicUrl;
    // Upgrade links only open this one tool's upgrade page. The manage link signs in
    // to My tools, but only after the person confirms on a page in their browser.
    const scoped = () => encodeURIComponent(this.users.entitlementToken(entitlement.userId, entitlement.id, 24 * 3600));
    const login = () => encodeURIComponent(this.users.loginToken(entitlement.userId, 3600));
    return {
      service,
      grant,
      entitlement,
      links: {
        upgrade: (planId) => `${base}/upgrade/${entitlement.id}?plan=${encodeURIComponent(planId)}&t=${scoped()}`,
        upgradeAny: () => `${base}/upgrade/${entitlement.id}?t=${scoped()}`,
        manage: () => `${base}/my/login?t=${login()}`,
        install: () => `${base}/add/${service.id}`,
      },
    };
  }

  rememberClient(grant, msg) {
    let info;
    let caps;
    let version;
    if (msg.method === 'initialize') {
      info = msg.params?.clientInfo;
      caps = msg.params?.capabilities;
      version = msg.params?.protocolVersion;
    } else if (msg.params?._meta?.[META_VERSION]) {
      info = msg.params._meta[META_CLIENT];
      caps = msg.params._meta[META_CAPS];
      version = msg.params._meta[META_VERSION];
    } else {
      return;
    }
    const same =
      grant.protocolVersion === version &&
      JSON.stringify(grant.clientInfo || null) === JSON.stringify(info || grant.clientInfo || null) &&
      JSON.stringify(grant.capabilities || null) === JSON.stringify(caps || null);
    if (same) return;
    grant.clientInfo = info || grant.clientInfo || null;
    grant.capabilities = caps || {};
    grant.protocolVersion = version;
    grant.lastSeenAt = Date.now();
    this.store.save();
  }

  // Answer a request locally, in the right shape for the client's protocol era.
  local(msg, result) {
    const modern = Boolean(msg.params?._meta?.[META_VERSION]);
    return rpcResult(msg.id, modern ? { resultType: 'complete', ...result } : result);
  }

  // Returns a decision: {id, local} to answer now, or {id, tool, started, costUsd, payment, body?} to forward.
  async decide(ctx, msg) {
    const { service, entitlement: e } = ctx;
    const name = msg.params?.name;
    if (name === STATUS_TOOL && service.statusTool) {
      return { id: msg.id, local: this.local(msg, { content: [{ type: 'text', text: statusText(ctx, this.store) }] }) };
    }

    // Strip anything that is ours before it reaches the upstream server.
    let params = msg.params || {};
    let changed = false;
    let declined = false;
    if (typeof params.requestState === 'string' && params.requestState.startsWith(STATE_PREFIX)) {
      const state = verify(this.config.secret, params.requestState.slice(STATE_PREFIX.length));
      const answer = Object.values(params.inputResponses || {})[0];
      declined = !state || state.e !== e.id || (answer && answer.action && answer.action !== 'accept');
      const { requestState, inputResponses, ...rest } = params;
      void requestState;
      void inputResponses;
      params = rest;
      changed = true;
    }

    const plan = planById(service, e.planId);
    const paid = Boolean(plan?.x402 && this.x402);
    const costUsd = paid ? Number(plan.x402.pricePerCall) : 0;
    const check = this.entitlements.check(e, name, { costUsd });
    if (!check.ok) return this.blocked(ctx, msg, check.reason, { tool: name, costUsd, declined });
    if (paid) {
      const policy = this.x402.checkPolicy(e, costUsd);
      if (!policy.ok) return this.blocked(ctx, msg, 'policy', { detail: policy.detail });
    }

    // Hold the call and its price before awaiting anything.
    this.entitlements.reserve(e, costUsd);

    let payment = null;
    if (paid) {
      payment = await this.x402.requirePayment(ctx, msg, null, plan);
      if (payment.local) {
        this.entitlements.release(e, costUsd);
        return { id: msg.id, local: this.local(msg, payment.local.result) };
      }
      if (params._meta?.[PAYMENT_META]) {
        const { [PAYMENT_META]: _p, ...meta } = params._meta;
        void _p;
        params = { ...params, _meta: meta };
        changed = true;
      }
    }

    return { id: msg.id, tool: name, started: Date.now(), costUsd, payment, body: changed ? { ...msg, params } : null };
  }

  blocked(ctx, msg, reason, extra = {}) {
    const text = blockedMessage(reason, ctx, extra);
    const upgradeable = reason === 'expired' || reason === 'calls' || reason === 'scope';
    const modern = Boolean(msg.params?._meta?.[META_VERSION]);
    if (upgradeable && !extra.declined && this.supportsUrlElicitation(ctx.grant, msg)) {
      const { service, entitlement: e } = ctx;
      const url = ctx.links.upgradeAny();
      const message = `${text.split('\n')[0]} Open the page to choose a plan.`;
      if (modern) {
        // 2026-07-28: input_required with a URL-mode elicitation; the client retries with requestState.
        return {
          id: msg.id,
          local: rpcResult(msg.id, {
            resultType: 'input_required',
            inputRequests: { upgrade: { method: 'elicitation/create', params: { mode: 'url', url, message } } },
            requestState: STATE_PREFIX + sign(this.config.secret, { e: e.id, t: extra.tool }, 3600),
          }),
        };
      }
      // 2025-11-25: URLElicitationRequiredError
      return {
        id: msg.id,
        local: rpcError(msg.id, URL_ELICITATION_REQUIRED, `${service.title}: upgrade needed`, {
          elicitations: [{ mode: 'url', elicitationId: `${e.id}.${Date.now()}`, url, message }],
        }),
      };
    }
    return { id: msg.id, local: this.local(msg, { content: [{ type: 'text', text }], isError: true }) };
  }

  supportsUrlElicitation(grant, msg) {
    const caps = msg?.params?._meta?.[META_CAPS] || grant.capabilities;
    return Boolean(caps?.elicitation?.url);
  }

  // ---------- forwarding ----------

  // Who is calling, so the publisher can serve per-person data. Only trust these
  // if the upstream is reachable through the gateway alone (use a shared secret header).
  identityHeaders(ctx) {
    const { entitlement: e, grant } = ctx;
    return {
      'x-handshake-user': e.userId,
      'x-handshake-entitlement': e.id,
      'x-handshake-plan': e.planId,
      'x-handshake-scopes': e.scopes.join(' '),
      // Percent-encoded: header values must be plain ASCII.
      'x-handshake-client': encodeURIComponent(String(grant.clientInfo?.name || grant.clientName || '').slice(0, 100)),
    };
  }

  upstreamHeaders(req, ctx, accept) {
    const h = { accept, 'user-agent': 'agent-handshake-gateway/0.1', ...this.identityHeaders(ctx) };
    for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('mcp-') || k === 'last-event-id') h[k] = v;
    return { ...h, ...ctx.service.upstream.headers };
  }

  async fetchUpstream(ctx, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timed out')), ctx.service.upstream.timeoutMs);
    init.res.on('close', () => {
      if (!init.res.writableFinished) controller.abort(new Error('client went away'));
    });
    try {
      return await fetch(ctx.service.upstream.url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  responseHeaders(upstream) {
    const h = { ...CORS_HEADERS };
    const ct = upstream.headers.get('content-type');
    if (ct) h['content-type'] = ct;
    upstream.headers.forEach((v, k) => {
      if (k.startsWith('mcp-')) h[k] = v;
    });
    if (ct?.includes('text/event-stream')) {
      h['cache-control'] = 'no-cache';
      h['x-accel-buffering'] = 'no';
    }
    return h;
  }

  upstreamFailure(res, ctx, detail, id = null) {
    this.log?.warn?.(`[${ctx.service.id}] upstream problem: ${detail}`);
    return sendJson(res, 502, rpcError(id, -32603, `${ctx.service.title} is not reachable through the gateway right now (${detail}).`), CORS_HEADERS);
  }

  async passthrough(req, res, ctx) {
    let upstream;
    try {
      upstream = await this.fetchUpstream(ctx, {
        method: req.method,
        headers: this.upstreamHeaders(req, ctx, req.method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream'),
        res,
      });
    } catch (err) {
      return this.upstreamFailure(res, ctx, err.message);
    }
    if (upstream.status === 401 || upstream.status === 403) {
      return this.upstreamFailure(res, ctx, 'the upstream server rejected the gateway credentials');
    }
    res.writeHead(upstream.status, this.responseHeaders(upstream));
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  }

  /**
   * opts.calls: Map<id, decision> for tools/call metering
   * opts.listIds: Set<id> of tools/list requests whose results we rewrite
   */
  async forward(req, res, ctx, raw, opts) {
    const calls = opts?.calls || new Map();
    const listIds = opts?.listIds || new Set();
    const settled = new Set();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableFinished) clientGone = true;
    });
    // Calls the upstream never ran (unreachable, error status) don't count.
    const releaseAll = () => {
      for (const [id, d] of calls) {
        if (settled.has(id)) continue;
        settled.add(id);
        this.entitlements.release(ctx.entitlement, d.costUsd);
      }
    };
    // The stream ended without a result. If the client hung up, the upstream may still
    // have done the work (and the result may be fetched another way), so the call
    // counts and a verified payment is settled. If the upstream ended early, it doesn't.
    const finishUnanswered = async () => {
      for (const [id, d] of calls) {
        if (settled.has(id)) continue;
        settled.add(id);
        if (!clientGone) {
          this.entitlements.release(ctx.entitlement, d.costUsd);
          continue;
        }
        let costUsd = 0;
        if (d.payment) costUsd = (await this.x402.settlePayment(d)).success ? d.costUsd : 0;
        this.entitlements.record(ctx.entitlement, { tool: d.tool, ok: false, latencyMs: Date.now() - d.started, costUsd, reservedUsd: d.costUsd, client: ctx.grant.clientInfo?.name || ctx.grant.clientName });
      }
    };
    const firstId = calls.size ? [...calls.keys()][0] : null;

    let upstream;
    try {
      upstream = await this.fetchUpstream(ctx, {
        method: 'POST',
        headers: { ...this.upstreamHeaders(req, ctx, 'application/json, text/event-stream'), 'content-type': 'application/json' },
        body: raw,
        res,
      });
    } catch (err) {
      releaseAll();
      return this.upstreamFailure(res, ctx, err.message, firstId);
    }
    if (upstream.status === 401 || upstream.status === 403) {
      releaseAll();
      return this.upstreamFailure(res, ctx, 'the upstream server rejected the gateway credentials', firstId);
    }

    const onMessage = async (msg) => {
      if (!msg || msg.id === undefined || msg.method) return msg;
      if (calls.has(msg.id) && !settled.has(msg.id)) {
        settled.add(msg.id);
        const d = calls.get(msg.id);
        let ok = !msg.error && !msg.result?.isError && msg.result?.resultType !== 'input_required';
        let out = msg;
        let costUsd = 0;
        if (d.payment && ok) {
          out = await this.x402.settle(ctx, d, msg);
          if (out.result?._meta?.[PAYMENT_RESPONSE_META]?.success) costUsd = d.costUsd;
          else ok = false;
          if (msg.result?.resultType && !out.result.resultType) out.result.resultType = msg.result.resultType;
        }
        if (msg.result?.resultType === 'input_required') {
          // The upstream needs more input; this isn't a finished call yet.
          this.entitlements.release(ctx.entitlement, d.costUsd);
          return out;
        }
        this.entitlements.record(ctx.entitlement, {
          tool: d.tool,
          ok,
          latencyMs: Date.now() - d.started,
          costUsd,
          reservedUsd: d.costUsd,
          client: ctx.grant.clientInfo?.name || ctx.grant.clientName,
        });
        return out;
      }
      if (listIds.has(msg.id) && msg.result?.tools) return { ...msg, result: this.rewriteTools(ctx, msg.result) };
      return msg;
    };

    const ct = upstream.headers.get('content-type') || '';
    const headers = this.responseHeaders(upstream);
    if (!upstream.ok || (!calls.size && !listIds.size) || !upstream.body) {
      // Nothing to inspect.
      releaseAll();
      res.writeHead(upstream.status, headers);
      if (!upstream.body) return res.end();
      return Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
    }

    if (ct.includes('text/event-stream')) {
      res.writeHead(upstream.status, headers);
      try {
        await transformSse(upstream.body, (chunk) => res.write(chunk), onMessage);
      } catch (err) {
        this.log?.warn?.(`[${ctx.service.id}] stream ended early: ${err.message}`);
      }
      await finishUnanswered();
      return res.end();
    }

    // JSON (single message or batch array)
    let text;
    try {
      text = await upstream.text();
    } catch (err) {
      this.log?.warn?.(`[${ctx.service.id}] response cut: ${err.message}`);
      await finishUnanswered();
      return res.end();
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      for (const m of parseSseMessages(text)) await onMessage(m);
      await finishUnanswered();
      res.writeHead(upstream.status, headers);
      return res.end(text);
    }
    const out = [];
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) out.push(await onMessage(m));
    await finishUnanswered();
    return sendJson(res, upstream.status, Array.isArray(parsed) ? out : out[0], headers);
  }

  rewriteTools(ctx, result) {
    const { service, entitlement: e } = ctx;
    const plan = { ...(planById(service, e.planId) || {}), scopes: e.scopes };
    let tools = result.tools;
    if (service.hideLockedTools) tools = tools.filter((t) => planAllowsTool(service, plan, t.name));
    if (service.statusTool && !tools.some((t) => t.name === STATUS_TOOL)) tools = [...tools, statusToolDefinition(service)];
    const out = { ...result, tools };
    // The list now depends on this person's plan, so it must not be cached as public.
    if (out.cacheScope === 'public') out.cacheScope = 'private';
    if (typeof out.ttlMs === 'number') out.ttlMs = Math.min(out.ttlMs, 300000);
    return out;
  }
}

export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}
