// Agent Handshake gateway: one Node process, no dependencies.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildConfig, ensureSecrets } from './config.js';
import { Store } from './store.js';
import { Entitlements } from './entitlements.js';
import { Users } from './users.js';
import { OAuth, OAuthError, redirectMatches } from './oauth/oauth.js';
import { McpProxy } from './mcp/proxy.js';
import { Checkout } from './billing/checkout.js';
import { X402 } from './billing/x402.js';
import { aiCatalog, AI_CATALOG_TYPE, llmsTxt, serverCard, SERVER_CARD_TYPE } from './discovery.js';
import { badgeSvg, buttonScript } from './button.js';
import { CORS_HEADERS, HttpError, clientIp, parseCookies, readBody, readForm, readJson, redirect, send, sendHtml, sendJson } from './util/http.js';
import { safeEqual, sign, verify } from './util/crypto.js';
import { freePlan, isFree, planById } from './terms.js';
import { installInfo, installPage } from './pages/install.js';
import { consentPage } from './pages/consent.js';
import { myPage } from './pages/my.js';
import { donePage, loginConfirmPage, testCheckoutPage, upgradePage, x402ConfirmPage } from './pages/upgrade.js';
import { adminLoginPage, adminPage } from './pages/admin.js';
import { errorPage } from './pages/layout.js';
import { appendHeader } from './users.js';
import { Hub } from './hub/hub.js';
import { HUB_ID } from './hub/identity.js';
import { hubServerCard } from './discovery.js';
import { agentsPage, connectPage, hubAddPage, hubAddedPage, storefrontPage } from './pages/hub.js';
import { hubConsentPage } from './pages/consent.js';
import { cookie } from './util/http.js';

const BRAND_DIR = new URL('../brand/', import.meta.url);
const ASSETS = {
  'handshake.css': { type: 'text/css; charset=utf-8', body: readFileSync(new URL('handshake.css', BRAND_DIR)) },
  'mark.svg': { type: 'image/svg+xml', body: readFileSync(new URL('mark.svg', BRAND_DIR)) },
  'logo.svg': { type: 'image/svg+xml', body: readFileSync(new URL('logo.svg', BRAND_DIR)) },
};

function makeLogger(quiet) {
  const out = (level) => (msg) => {
    if (quiet && level !== 'error') return;
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    (level === 'error' ? console.error : console.log)(line);
  };
  return { info: out('info'), warn: out('warn'), error: out('error') };
}

/**
 * Create a gateway. `input` is either a raw config object (as in handshake.config.json)
 * or the result of buildConfig().
 */
export function createGateway(input, { baseDir, overrides, memory = false, fetchImpl } = {}) {
  const config = input.built ? input : buildConfig(input, { baseDir, overrides });
  ensureSecrets(config);
  const log = makeLogger(config.quiet);
  const store = new Store(memory ? null : config.dataDir);
  const services = new Map(config.services.map((s) => [s.id, s]));
  const entitlements = new Entitlements(store, services);
  const users = new Users(store, config);
  const oauth = new OAuth({ store, config, services });
  const checkout = new Checkout({ config, store, entitlements, services, log });
  const x402 = new X402({ config, store, users, entitlements, log, fetchImpl });
  const proxy = new McpProxy({ config, services, oauth, entitlements, users, store, x402, log });
  const hub = new Hub({ config, services, oauth, entitlements, users, store, x402, proxy, checkout, log });
  const ctx = { config, store, services, entitlements, users, oauth, checkout, x402, proxy, hub, log };

  const routes = buildRoutes(ctx);
  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, config.publicUrl);
    res.on('finish', () => {
      if (!url.pathname.startsWith('/assets/')) log.info(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '', CORS_HEADERS);
      for (const [method, pattern, handler] of routes) {
        if (method !== '*' && method !== req.method && !(method === 'GET' && req.method === 'HEAD')) continue;
        const m = pattern.exec(url.pathname);
        if (m) return await handler(req, res, { url, params: m.groups || {}, query: Object.fromEntries(url.searchParams) });
      }
      return sendHtml(res, 404, errorPage(config, { title: 'Not found', message: 'There is nothing at this address.', status: 404 }));
    } catch (err) {
      return handleError(ctx, req, res, url, err);
    }
  });

  const gc = setInterval(() => store.gc(), 10 * 60 * 1000);
  gc.unref();

  return {
    ...ctx,
    server,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      clearInterval(gc);
      store.flush();
      await new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
    },
  };
}

function handleError({ config, log }, req, res, url, err) {
  const api = /^\/(oauth|v1|mcp|webhooks)(\/|$)/.test(url.pathname);
  if (err instanceof OAuthError) return sendJson(res, err.status, err.toJSON(), { ...CORS_HEADERS, 'cache-control': 'no-store' });
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) log.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
  const message = status >= 500 ? 'Something went wrong on the gateway.' : err.message;
  if (api) return sendJson(res, status, { error: status >= 500 ? 'server_error' : 'invalid_request', error_description: message }, CORS_HEADERS);
  return sendHtml(res, status, errorPage(config, { title: status === 404 ? 'Not found' : 'Something went wrong', message, status }));
}

function etagFor(body) {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

function sendCacheable(req, res, body, type, extra = {}) {
  const etag = etagFor(body);
  const headers = { 'content-type': type, etag, 'cache-control': 'public, max-age=300', ...extra };
  if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
  return send(res, 200, req.method === 'HEAD' ? '' : body, headers);
}

const DISCOVERY_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'Content-Type, If-None-Match',
  'access-control-expose-headers': 'ETag',
};

function buildRoutes(ctx) {
  const { config, store, services, entitlements, users, oauth, checkout, proxy, hub, log } = ctx;
  const R = [];
  const route = (method, path, handler) => R.push([method, new RegExp(`^${path}$`), handler]);
  const service = (id) => {
    const s = services.get(id);
    if (!s) throw new HttpError(404, `There is no tool called "${id}" on this gateway.`);
    return s;
  };
  const html = (res, body, status = 200) => sendHtml(res, status, body, { 'cache-control': 'no-store', link: '</.well-known/ai-catalog.json>; rel="ai-catalog"' });
  const requireUser = (req) => {
    const user = users.current(req);
    if (!user) throw new HttpError(401, 'Open this page in the browser where you added the tool, or ask your agent for a new link (run handshake_status).');
    return user;
  };
  // Access to one entitlement: either the person's browser session, or a link scoped
  // to this entitlement only (what the agent hands out).
  const ownEntitlement = (req, id, token) => {
    const e = entitlements.get(id);
    const scopedUid = token ? users.readEntitlementToken(token, id) : null;
    if (token && !scopedUid) throw new HttpError(400, 'This link expired. Ask your agent for a new one (it runs handshake_status).');
    const user = scopedUid ? store.get('users', scopedUid) : requireUser(req);
    if (!e || !user || e.userId !== user.id) throw new HttpError(404, 'That tool is not in your list. Open this link in the browser where you added it, or ask your agent for a new link.');
    return { user, e, service: service(e.serviceId), scoped: Boolean(scopedUid) };
  };
  // Changing plans away from a Stripe subscription cancels it and clears billing.
  const switchPlan = async (e, planId) => {
    await checkout.cancel(e);
    return entitlements.changePlan(e.id, planId, { billing: null });
  };
  const donePath = (serviceId, planId) => `/checkout/done?service=${encodeURIComponent(serviceId)}&plan=${encodeURIComponent(planId)}`;
  const checkCsrf = (req, form, purpose) => {
    const uid = users.uidFromRequest(req);
    if (!users.checkCsrf(uid, form.csrf, purpose)) throw new HttpError(403, 'This form expired. Reload the page and try again.');
  };
  const requireAdmin = (req) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ') && safeEqual(h.slice(7).trim(), config.adminKey)) return true;
    throw new HttpError(401, 'Send the admin key as "Authorization: Bearer <key>"');
  };

  // ---------- static + discovery ----------
  route('GET', '/healthz', (req, res) => sendJson(res, 200, { ok: true, services: [...services.keys()] }));
  route('GET', '/assets/(?<file>[a-z.-]+)', (req, res, { params }) => {
    const a = ASSETS[params.file];
    if (!a) throw new HttpError(404, 'Not found');
    return sendCacheable(req, res, a.body, a.type, { 'access-control-allow-origin': '*' });
  });
  route('GET', '/favicon.ico', (req, res) => sendCacheable(req, res, ASSETS['mark.svg'].body, 'image/svg+xml'));
  route('GET', '/button.js', (req, res) => sendCacheable(req, res, buttonScript(config.publicUrl), 'text/javascript; charset=utf-8', { 'access-control-allow-origin': '*' }));
  route('GET', '/badge(?:/(?<id>[a-z0-9-]+))?\\.svg', (req, res, { query }) =>
    sendCacheable(req, res, badgeSvg({ label: query.label || 'Add to my agent', theme: query.theme }), 'image/svg+xml', { 'access-control-allow-origin': '*' }),
  );
  route('GET', '/llms.txt', (req, res) => sendCacheable(req, res, llmsTxt(config, [...services.values()]), 'text/plain; charset=utf-8'));
  route('GET', '/.well-known/ai-catalog.json', (req, res) =>
    sendCacheable(req, res, JSON.stringify(aiCatalog(config, [...services.values()]), null, 2), AI_CATALOG_TYPE, DISCOVERY_CORS),
  );
  route('GET', '/mcp/server-card', (req, res) =>
    sendCacheable(req, res, JSON.stringify(hubServerCard(config, [...services.values()]), null, 2), SERVER_CARD_TYPE, DISCOVERY_CORS),
  );
  route('GET', '/mcp/(?<id>[a-z0-9-]+)/server-card', (req, res, { params }) =>
    sendCacheable(req, res, JSON.stringify(serverCard(config, service(params.id)), null, 2), SERVER_CARD_TYPE, DISCOVERY_CORS),
  );

  // ---------- OAuth metadata ----------
  const asMeta = (req, res) => sendJson(res, 200, oauth.authorizationServerMetadata(), { ...CORS_HEADERS, 'cache-control': 'public, max-age=300' });
  route('GET', '/.well-known/oauth-authorization-server', asMeta);
  route('GET', '/.well-known/openid-configuration', asMeta);
  route('GET', '/.well-known/oauth-protected-resource/mcp', (req, res) =>
    sendJson(res, 200, oauth.protectedResourceMetadata(HUB_ID), { ...CORS_HEADERS, 'cache-control': 'public, max-age=300' }),
  );
  route('GET', '/.well-known/oauth-protected-resource/mcp/(?<id>[a-z0-9-]+)', (req, res, { params }) =>
    sendJson(res, 200, oauth.protectedResourceMetadata(service(params.id).id), { ...CORS_HEADERS, 'cache-control': 'public, max-age=300' }),
  );
  // The root describes the hub, the main thing to connect to.
  route('GET', '/.well-known/oauth-protected-resource', (req, res) => sendJson(res, 200, oauth.protectedResourceMetadata(HUB_ID), CORS_HEADERS));

  // ---------- OAuth endpoints ----------
  route('POST', '/oauth/register', async (req, res) => {
    const body = await readJson(req, 16 * 1024);
    const client = oauth.register(body, clientIp(req));
    return sendJson(res, 201, client, { ...CORS_HEADERS, 'cache-control': 'no-store' });
  });
  route('POST', '/oauth/token', async (req, res) => {
    const form = await readForm(req);
    const tokens = await oauth.token(form, req.headers);
    return sendJson(res, 200, tokens, { ...CORS_HEADERS, 'cache-control': 'no-store', pragma: 'no-cache' });
  });
  route('POST', '/oauth/revoke', async (req, res) => {
    const form = await readForm(req);
    await oauth.revoke(form, req.headers);
    return send(res, 200, '', CORS_HEADERS);
  });

  route('GET', '/oauth/authorize', async (req, res, { query }) => {
    let v;
    try {
      v = await oauth.validateAuthorizeRequest(query);
    } catch (err) {
      // Never redirect a request we couldn't validate: anyone can register a client,
      // so that would be an open redirect (RFC 9700 §4.11.1). Show the problem instead.
      return html(res, errorPage(config, { title: 'This sign-in link is not valid', message: err.description || err.message, status: 400 }), 400);
    }
    const uid = users.ensureUid(req, res);
    const requestToken = sign(config.secret, { k: 'authz', p: v.params }, 15 * 60);
    if (v.service.hub) {
      const known = store.get('users', uid);
      const pendingId = parseCookies(req).ah_pending;
      const pending = pendingId && services.get(pendingId) && !(known && entitlements.current(uid, pendingId)) ? services.get(pendingId) : null;
      return html(
        res,
        hubConsentPage({ config, client: v.client, params: v.params, requestToken, csrf: users.csrf(uid, 'authz'), pending, autoTrials: known?.agentCanStartTrials !== false }),
      );
    }
    const existing = store.get('users', uid) ? entitlements.current(uid, v.service.id) : null;
    return html(
      res,
      consentPage({ config, service: v.service, client: v.client, params: v.params, requestToken, csrf: users.csrf(uid, 'authz'), existing }),
    );
  });

  route('POST', '/oauth/authorize', async (req, res) => {
    const form = await readForm(req);
    const uid = users.uidFromRequest(req);
    if (!users.checkCsrf(uid, form.csrf, 'authz')) {
      return html(res, errorPage(config, { title: 'This page expired', message: 'Go back to your agent app and connect again.', status: 403 }), 403);
    }
    const body = verify(config.secret, form.request);
    if (body?.k !== 'authz') {
      return html(res, errorPage(config, { title: 'This page expired', message: 'Go back to your agent app and connect again.', status: 400 }), 400);
    }
    const params = body.p;
    const client = await oauth.resolveClient(params.client_id);
    if (!redirectMatches(client.redirect_uris, params.redirect_uri)) throw new HttpError(400, 'redirect_uri no longer matches the client');
    const svcId = oauth.serviceForResource(params.resource);
    const svc = svcId ? oauth.serviceOrHub(svcId) : null;
    if (!svc) throw new HttpError(404, 'That tool is not on this gateway any more.');
    if (form.decision !== 'allow') {
      return redirect(res, oauth.errorRedirect({ redirectUri: params.redirect_uri, state: params.state, error: 'access_denied', description: 'The person cancelled' }));
    }
    const person = users.getOrCreate(uid);
    if (svc.hub) {
      person.agentCanStartTrials = form.auto !== '0';
      if (form.also && services.get(form.also)) {
        try {
          entitlements.connect(uid, form.also, { ip: clientIp(req) });
        } catch (err) {
          log.warn(`[hub] could not add ${form.also}: ${err.message}`);
        }
      }
      store.save();
      const grant = oauth.createGrant({ userId: uid, service: svc, client, entitlement: null });
      log.info(`[hub] connected ${client.client_name || client.client_id} for ${uid}`);
      appendHeader(res, 'set-cookie', 'ah_pending=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      return redirect(res, oauth.issueCode(params, grant));
    }
    let entitlement;
    try {
      ({ entitlement } = entitlements.connect(uid, svc.id, { ip: clientIp(req) }));
    } catch (err) {
      if (err.code === 'revoked') return html(res, errorPage(config, { title: 'Access turned off', message: err.message, status: 403 }), 403);
      if (err.code !== 'trial_rate_limited') throw err;
      return html(
        res,
        consentPage({ config, service: svc, client, params, requestToken: form.request, csrf: users.csrf(uid, 'authz'), existing: null, error: err.message }),
        429,
      );
    }
    const grant = oauth.createGrant({ userId: uid, service: svc, client, entitlement });
    log.info(`[${svc.id}] connected ${client.client_name || client.client_id} for ${uid} (${entitlement.planId}, ${entitlement.status})`);
    return redirect(res, oauth.issueCode(params, grant));
  });

  // ---------- MCP ----------
  route('*', '/mcp/?', (req, res) => hub.handle(req, res));
  route('*', '/mcp/(?<id>[a-z0-9-]+)/?', (req, res, { params }) => proxy.handle(req, res, params.id));

  // ---------- pages ----------
  const hubConnected = (uid) => Boolean(uid && store.findOne('grants', (g) => g.userId === uid && g.serviceId === HUB_ID && !g.revokedAt));
  const myEntitlements = (uid) => new Map((uid ? entitlements.forUser(uid) : []).map((e) => [e.serviceId, e]));

  route('GET', '/', (req, res) => {
    const user = users.current(req);
    return html(res, storefrontPage({ config, services: [...services.values()], user, connected: hubConnected(user?.id), mine: myEntitlements(user?.id) }));
  });
  route('GET', '/connect', (req, res) => {
    const user = users.current(req);
    const pending = services.get(parseCookies(req).ah_pending || '');
    return html(res, connectPage({ config, user, connected: hubConnected(user?.id), pending }));
  });
  route('GET', '/agents', (req, res) => html(res, agentsPage({ config, services: [...services.values()] })));

  // The "Add to my agent" button lands here. Connected people add with one click;
  // everyone else connects once, and this tool comes along.
  route('GET', '/add/(?<id>[a-z0-9-]+)', (req, res, { params, query }) => {
    const s = service(params.id);
    if (query.format === 'json') return sendJson(res, 200, installInfo(config, s), CORS_HEADERS);
    const user = users.current(req);
    if (hubConnected(user?.id)) return redirect(res, `/hub/add/${s.id}`);
    const existing = user ? entitlements.current(user.id, s.id) : null;
    appendHeader(res, 'set-cookie', cookie('ah_pending', s.id, { maxAge: 1800, secure: config.publicUrl.startsWith('https://') }));
    return html(res, installPage({ config, service: s, user, existing: existing && existing.status !== 'dropped' ? existing : null }));
  });

  // Adding a tool to an agent that's already connected to the hub.
  // Works from the browser session, or from a link the agent handed out (?t=).
  const hubAddWho = (req, s, token) => {
    if (token) {
      const uid = users.readAddToken(token, s.id);
      if (!uid || !store.get('users', uid)) throw new HttpError(400, 'This link expired. Ask your agent for a new one.');
      return { uid, scoped: true };
    }
    const uid = users.uidFromRequest(req);
    return { uid: hubConnected(uid) ? uid : null, scoped: false };
  };
  route('GET', '/hub/add/(?<id>[a-z0-9-]+)', (req, res, { params, query }) => {
    const s = service(params.id);
    const { uid, scoped } = hubAddWho(req, s, query.t);
    if (!uid) return redirect(res, `/add/${s.id}`);
    const existing = entitlements.current(uid, s.id);
    return html(res, hubAddPage({ config, service: s, user: users.current(req), csrf: scoped ? '' : users.csrf(uid, 'hub'), token: scoped ? query.t : null, existing }));
  });
  route('POST', '/hub/add/(?<id>[a-z0-9-]+)', async (req, res, { params }) => {
    const s = service(params.id);
    const form = await readForm(req);
    const { uid, scoped } = hubAddWho(req, s, form.t);
    if (!uid) return redirect(res, `/add/${s.id}`, 303);
    if (!scoped && !users.checkCsrf(uid, form.csrf, 'hub')) throw new HttpError(403, 'This form expired. Reload the page and try again.');
    try {
      entitlements.connect(uid, s.id, { ip: clientIp(req) });
    } catch (err) {
      const existing = entitlements.current(uid, s.id);
      return html(res, hubAddPage({ config, service: s, user: users.current(req), csrf: scoped ? '' : users.csrf(uid, 'hub'), token: scoped ? form.t : null, existing, error: err.message }), 400);
    }
    log.info(`[hub] ${uid} added ${s.id} from the browser`);
    return redirect(res, `/hub/added/${s.id}`, 303);
  });
  route('GET', '/hub/added/(?<id>[a-z0-9-]+)', (req, res, { params }) => html(res, hubAddedPage({ config, service: service(params.id), user: users.current(req) })));

  route('POST', '/my/agent-settings', async (req, res) => {
    const form = await readForm(req);
    checkCsrf(req, form, 'my');
    const user = requireUser(req);
    user.agentCanStartTrials = form.auto === '1';
    store.save();
    return redirect(res, '/my?saved=agent', 303);
  });

  // Sign-in links never sign you in by just opening them: you confirm with a button,
  // and you're told if this browser already holds a different list of tools.
  route('GET', '/my/login', (req, res, { query }) => {
    const uid = users.consumeLoginToken(query.t);
    if (!uid || !store.get('users', uid)) {
      return html(res, errorPage(config, { title: 'This link expired', message: 'Ask your agent for a new one (it runs handshake_status).', status: 400 }), 400);
    }
    const current = users.uidFromRequest(req);
    if (current === uid) return redirect(res, '/my');
    const theirs = entitlements.forUser(uid).filter((e) => e.status !== 'dropped').map((e) => services.get(e.serviceId)?.title).filter(Boolean);
    const mine = current && store.get('users', current) ? entitlements.forUser(current).filter((e) => e.status !== 'dropped').length : 0;
    return html(res, loginConfirmPage({ config, token: query.t, tools: theirs, switching: mine > 0 }));
  });
  route('POST', '/my/login', async (req, res) => {
    const form = await readForm(req);
    const uid = users.consumeLoginToken(form.t);
    if (!uid || !store.get('users', uid)) throw new HttpError(400, 'This link expired. Ask your agent for a new one.');
    users.setCookie(res, uid);
    return redirect(res, '/my', 303);
  });

  route('GET', '/my', (req, res, { query }) => {
    const user = users.current(req);
    const uid = users.uidFromRequest(req);
    const list = user ? entitlements.forUser(user.id) : [];
    const title = (id) => services.get(id)?.title || id;
    let notice = null;
    if (query.upgraded) notice = { text: `Upgraded ${title(query.upgraded)}. Your agent can use the new plan right away.` };
    else if (query.removed) notice = { text: `Removed ${title(query.removed)}. Your agent can no longer use it. You can also delete it from your agent app's settings.` };
    else if (query.kept) notice = { text: `${title(query.kept)} is on the free plan now.` };
    else if (query.canceled) notice = { text: 'Checkout canceled. Nothing was charged.', tone: 'warn' };
    else if (query.saved === 'agent') notice = { text: 'Saved. Your agent will follow this the next time it adds a tool.' };
    else if (query.saved) notice = { text: 'Spending limits saved.' };
    else if (query.payg) notice = { text: `Pay per call is on for ${title(query.payg)}.` };
    const hubGrants = user ? store.find('grants', (g) => g.userId === user.id && g.serviceId === HUB_ID && !g.revokedAt) : [];
    return html(res, myPage({ config, user, entitlements: list, services, store, csrf: uid ? users.csrf(uid, 'my') : '', notice, hubGrants }));
  });

  route('POST', '/my/(?<id>ent_[A-Za-z0-9_-]+)/remove', async (req, res, { params }) => {
    const form = await readForm(req);
    checkCsrf(req, form, 'my');
    const { e, service: s } = ownEntitlement(req, params.id);
    await checkout.cancel(e);
    entitlements.drop(e.id, 'person');
    log.info(`[${s.id}] removed by ${e.userId}`);
    return redirect(res, `/my?removed=${s.id}`, 303);
  });

  route('POST', '/my/(?<id>ent_[A-Za-z0-9_-]+)/keep-free', async (req, res, { params }) => {
    const form = await readForm(req);
    checkCsrf(req, form, 'my');
    const { e, service: s } = ownEntitlement(req, params.id);
    const free = freePlan(s);
    if (free && e.planId !== free.id) await switchPlan(e, free.id);
    return redirect(res, `/my?kept=${s.id}`, 303);
  });

  route('POST', '/my/spend-policy', async (req, res) => {
    const form = await readForm(req);
    checkCsrf(req, form, 'my');
    const user = requireUser(req);
    const num = (v) => (v === undefined || v === '' ? undefined : Math.max(0, Number(v)));
    user.spendPolicy = { perCallUsd: num(form.perCallUsd), perDayUsd: num(form.perDayUsd), perMonthUsd: num(form.perMonthUsd) };
    store.save();
    return redirect(res, '/my?saved=1', 303);
  });

  // Upgrade links from the agent carry a token for this one tool (?t=). It opens this
  // page and nothing else; it doesn't sign the browser in.
  route('GET', '/upgrade/(?<id>ent_[A-Za-z0-9_-]+)', (req, res, { params, query }) => {
    const { user, e, service: s, scoped } = ownEntitlement(req, params.id, query.t);
    const uid = users.uidFromRequest(req);
    return html(
      res,
      upgradePage({ config, e, service: s, user, csrf: scoped ? '' : users.csrf(uid, 'my'), token: scoped ? query.t : null, selected: query.plan, mode: config.payments.mode }),
    );
  });

  route('GET', '/upgrade', (req, res, { query }) => {
    const s = service(query.service || '');
    const user = users.current(req);
    const e = user ? entitlements.current(user.id, s.id) : null;
    if (!e || e.status === 'dropped') return redirect(res, `/add/${s.id}`);
    return redirect(res, `/upgrade/${e.id}${query.plan ? `?plan=${encodeURIComponent(query.plan)}` : ''}`);
  });

  route('POST', '/upgrade/(?<id>ent_[A-Za-z0-9_-]+)', async (req, res, { params }) => {
    const form = await readForm(req);
    if (!form.t) checkCsrf(req, form, 'my');
    const { user, e, service: s, scoped } = ownEntitlement(req, params.id, form.t);
    const plan = planById(s, form.plan);
    if (!plan) throw new HttpError(400, 'Pick a plan');
    const why = entitlements.whyNotSwitch(e, plan);
    if (why) throw new HttpError(400, why);
    if (isFree(plan)) {
      await switchPlan(e, plan.id);
      return redirect(res, scoped ? donePath(s.id, plan.id) : `/my?kept=${s.id}`, 303);
    }
    if (plan.x402) {
      if (form.confirm !== '1') {
        return html(res, x402ConfirmPage({ config, e, service: s, plan, user, csrf: scoped ? '' : users.csrf(user.id, 'my'), token: scoped ? form.t : null }));
      }
      await switchPlan(e, plan.id);
      return redirect(res, scoped ? donePath(s.id, plan.id) : `/my?payg=${s.id}`, 303);
    }
    const to = await checkout.start(e, plan);
    return redirect(res, to, 303);
  });

  route('GET', '/checkout/test', (req, res, { query }) => {
    const t = checkout.readTestTicket(query.ticket);
    if (!t || config.payments.mode !== 'test') throw new HttpError(400, 'This checkout link expired. Start the upgrade again from My tools.');
    const e = entitlements.get(t.e);
    const s = service(e.serviceId);
    return html(res, testCheckoutPage({ config, e, service: s, plan: planById(s, t.p), ticket: query.ticket, user: users.current(req) }));
  });
  route('POST', '/checkout/test', async (req, res) => {
    if (config.payments.mode !== 'test') throw new HttpError(400, 'Test checkout is off');
    const form = await readForm(req);
    const e = await checkout.completeTest(form.ticket);
    log.info(`[${e.serviceId}] test payment: ${e.id} -> ${e.planId}`);
    return redirect(res, donePath(e.serviceId, e.planId), 303);
  });
  route('GET', '/checkout/stripe/return', async (req, res, { query }) => {
    const e = await checkout.completeStripe(query.session_id || '');
    if (!e) return redirect(res, '/my?canceled=1');
    return redirect(res, donePath(e.serviceId, e.planId));
  });
  route('GET', '/checkout/done', (req, res, { query }) => {
    const s = service(query.service || '');
    const plan = planById(s, query.plan) || s.plans[0];
    return html(res, donePage({ config, service: s, plan, user: users.current(req) }));
  });
  route('POST', '/webhooks/stripe', async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    try {
      return sendJson(res, 200, await checkout.webhook(raw, req.headers['stripe-signature']));
    } catch (err) {
      log.warn(`Stripe webhook rejected: ${err.message}`);
      return sendJson(res, 400, { error: err.message });
    }
  });

  // ---------- publisher dashboard ----------
  const adminCsrf = () => users.csrf('admin', 'admin');
  route('GET', '/admin', (req, res, { query }) => {
    if (!users.isAdmin(req)) return html(res, adminLoginPage({ config }));
    return html(res, adminPage({ config, services, store, entitlements, csrf: adminCsrf(), notice: query.notice }));
  });
  route('POST', '/admin/login', async (req, res) => {
    const form = await readForm(req);
    if (!form.key || !safeEqual(String(form.key).trim(), config.adminKey)) {
      await new Promise((r) => setTimeout(r, 400));
      return html(res, adminLoginPage({ config, error: 'That key is not right.' }), 401);
    }
    appendHeader(res, 'set-cookie', users.adminCookie());
    return redirect(res, '/admin', 303);
  });
  route('POST', '/admin/logout', async (req, res) => {
    appendHeader(res, 'set-cookie', 'ah_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return redirect(res, '/admin', 303);
  });
  route('POST', '/admin/entitlements/(?<id>ent_[A-Za-z0-9_-]+)', async (req, res, { params }) => {
    if (!users.isAdmin(req)) throw new HttpError(401, 'Sign in first');
    const form = await readForm(req);
    if (!form.csrf || !safeEqual(form.csrf, adminCsrf())) throw new HttpError(403, 'This form expired. Reload and try again.');
    const e = entitlements.get(params.id);
    if (!e) throw new HttpError(404, 'Not found');
    let notice;
    if (form.action === 'extend7') {
      entitlements.extend(e.id, 7);
      notice = 'Extended by 7 days.';
    } else if (form.action === 'grant') {
      entitlements.changePlan(e.id, form.plan, { billing: { provider: 'admin' } });
      notice = `Plan set to ${form.plan}.`;
    } else if (form.action === 'revoke') {
      await checkout.cancel(e);
      entitlements.drop(e.id, 'admin');
      notice = 'Access revoked.';
    }
    return redirect(res, `/admin?notice=${encodeURIComponent(notice || '')}`, 303);
  });

  // ---------- publisher API (Bearer admin key) ----------
  const entJson = (e) => ({ ...e, usage: store.usageDays(e.id) });
  route('GET', '/v1/services', (req, res) => {
    requireAdmin(req);
    return sendJson(res, 200, { services: [...services.values()].map((s) => ({ id: s.id, title: s.title, name: s.name, plans: s.plans })) });
  });
  route('GET', '/v1/entitlements', (req, res, { query }) => {
    requireAdmin(req);
    let list = store.all('entitlements').map((e) => entitlements.refresh(e));
    if (query.service) list = list.filter((e) => e.serviceId === query.service);
    if (query.user) list = list.filter((e) => e.userId === query.user);
    if (query.status) list = list.filter((e) => e.status === query.status);
    return sendJson(res, 200, { entitlements: list });
  });
  route('POST', '/v1/entitlements', async (req, res) => {
    requireAdmin(req);
    const body = await readJson(req);
    const s = service(body.serviceId || '');
    if (!body.userId || !store.get('users', body.userId)) throw new HttpError(400, 'userId must be an existing user');
    const plan = planById(s, body.planId) || freePlan(s) || s.plans[0];
    const existing = entitlements.current(body.userId, s.id);
    const e = existing ? entitlements.changePlan(existing.id, plan.id, { billing: { provider: 'api' } }) : entitlements.create(body.userId, s, plan);
    return sendJson(res, existing ? 200 : 201, entJson(e));
  });
  route('GET', '/v1/entitlements/(?<id>ent_[A-Za-z0-9_-]+)', (req, res, { params }) => {
    requireAdmin(req);
    const e = entitlements.get(params.id);
    if (!e) throw new HttpError(404, 'Not found');
    return sendJson(res, 200, entJson(e));
  });
  route('DELETE', '/v1/entitlements/(?<id>ent_[A-Za-z0-9_-]+)', async (req, res, { params }) => {
    requireAdmin(req);
    const e = entitlements.get(params.id);
    if (!e) throw new HttpError(404, 'Not found');
    await checkout.cancel(e);
    return sendJson(res, 200, entJson(entitlements.drop(e.id, 'admin')));
  });
  route('POST', '/v1/entitlements/(?<id>ent_[A-Za-z0-9_-]+)/activate', async (req, res, { params }) => {
    requireAdmin(req);
    const body = await readJson(req);
    const e = entitlements.get(params.id);
    if (!e) throw new HttpError(404, 'Not found');
    const s = service(e.serviceId);
    const plan = planById(s, body.planId);
    if (!plan) throw new HttpError(400, `Unknown planId. Use one of: ${s.plans.map((p) => p.id).join(', ')}`);
    checkout.recordPayment(e, plan, 'external', body.reference || null);
    return sendJson(res, 200, entJson(entitlements.changePlan(e.id, plan.id, { billing: { provider: 'external', reference: body.reference || null } })));
  });
  route('POST', '/v1/entitlements/(?<id>ent_[A-Za-z0-9_-]+)/upgrade', async (req, res, { params }) => {
    requireAdmin(req);
    const body = await readJson(req);
    const e = entitlements.get(params.id);
    if (!e) throw new HttpError(404, 'Not found');
    const plan = planById(service(e.serviceId), body.planId);
    if (!plan || isFree(plan)) throw new HttpError(400, 'planId must be a paid plan');
    return sendJson(res, 200, { url: await checkout.start(e, plan) });
  });
  route('POST', '/v1/entitlements/(?<id>ent_[A-Za-z0-9_-]+)/extend', async (req, res, { params }) => {
    requireAdmin(req);
    const body = await readJson(req);
    const e = entitlements.get(params.id);
    if (!e) throw new HttpError(404, 'Not found');
    return sendJson(res, 200, entJson(entitlements.extend(e.id, Number(body.days) || 7)));
  });

  return R;
}
