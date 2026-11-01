// The hub talks to each tool's MCP server as an MCP client.
// Works with session-based servers (initialize + Mcp-Session-Id) and with
// stateless 2026-07-28 servers (per-request _meta), JSON or SSE replies.

import { parseSseMessages } from '../mcp/sse.js';

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
const CLIENT_INFO = { name: 'agent-handshake-hub', title: 'Agent Handshake', version: '0.2.0' };
const TOOLS_TTL = 5 * 60 * 1000;

export class UpstreamError extends Error {}

export class UpstreamClient {
  constructor(service, { log } = {}) {
    this.service = service;
    this.log = log;
    this.mode = null; // 'legacy' | 'modern'
    this.session = null;
    this.protocol = LEGACY;
    this.nextId = 1;
    this.tools = null; // { list, until }
    this.starting = null;
  }

  async post(message, extraHeaders = {}) {
    const { url, headers, timeoutMs } = this.service.upstream;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'user-agent': 'agent-handshake-hub/0.2',
          ...extraHeaders,
          ...headers,
        },
        body: JSON.stringify(message),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs || 120000),
      });
    } catch (err) {
      throw new UpstreamError(`not reachable (${err.cause?.code || err.message})`);
    }
    if (res.status === 401 || res.status === 403) throw new UpstreamError('the server rejected the gateway credentials');
    const text = await res.text();
    const ct = res.headers.get('content-type') || '';
    let messages = [];
    if (ct.includes('text/event-stream')) messages = parseSseMessages(text);
    else if (text) {
      try {
        const parsed = JSON.parse(text);
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        messages = parseSseMessages(text);
      }
    }
    return { status: res.status, headers: res.headers, messages };
  }

  async start(identity) {
    if (this.mode) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const r = await this.post(
        { jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: CLIENT_INFO } },
        identity,
      );
      const result = r.messages.find((m) => m.result)?.result;
      if (r.status === 200 && result) {
        this.mode = 'legacy';
        this.session = r.headers.get('mcp-session-id');
        this.protocol = result.protocolVersion || LEGACY;
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, this.sessionHeaders(identity)).catch(() => {});
      } else {
        // A stateless-only server refuses initialize. Talk to it the 2026-07-28 way.
        this.mode = 'modern';
        this.protocol = MODERN;
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  sessionHeaders(identity, method, name) {
    const h = { ...identity, 'mcp-protocol-version': this.protocol };
    if (this.mode === 'legacy' && this.session) h['mcp-session-id'] = this.session;
    if (this.mode === 'modern') {
      h['mcp-method'] = method;
      if (name) h['mcp-name'] = /^[\x20-\x7e]*$/.test(name) ? name : `=?base64?${Buffer.from(name).toString('base64')}?=`;
    }
    return h;
  }

  /** Send one request; returns the JSON-RPC response message. */
  async request(method, params = {}, identity = {}, retried = false) {
    await this.start(identity);
    const p = { ...params };
    if (this.mode === 'modern') {
      p._meta = {
        ...(p._meta || {}),
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
      };
    }
    const id = this.nextId++;
    const r = await this.post({ jsonrpc: '2.0', id, method, params: p }, this.sessionHeaders(identity, method, p.name));
    if ((r.status === 404 || r.status === 400) && this.mode === 'legacy' && !retried) {
      // Session expired: start over once.
      this.mode = null;
      this.session = null;
      return this.request(method, params, identity, true);
    }
    const msg = r.messages.find((m) => m && m.id === id);
    if (!msg) throw new UpstreamError(`no answer (HTTP ${r.status})`);
    return msg;
  }

  async listTools(identity = {}) {
    if (this.tools && this.tools.until > Date.now()) return this.tools.list;
    const list = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const msg = await this.request('tools/list', cursor ? { cursor } : {}, identity);
      if (msg.error) throw new UpstreamError(msg.error.message || 'tools/list failed');
      list.push(...(msg.result?.tools || []));
      cursor = msg.result?.nextCursor;
      if (!cursor) break;
    }
    this.tools = { list, until: Date.now() + TOOLS_TTL };
    return list;
  }
}
