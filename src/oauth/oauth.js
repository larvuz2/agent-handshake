// OAuth 2.1 authorization server for MCP clients.
// - Protected Resource Metadata (RFC 9728), AS metadata (RFC 8414)
// - Client ID Metadata Documents (CIMD) and Dynamic Client Registration (RFC 7591)
// - Authorization code + PKCE S256, resource indicators (RFC 8707), iss (RFC 9207)
// - Refresh token rotation, revocation (RFC 7009)

import { HttpError } from '../util/http.js';
import { pkceMatches, randomId, randomToken, safeEqual, sha256 } from '../util/crypto.js';
import { fetchClientMetadata } from './cimd.js';
import { HUB_ID, hubService } from '../hub/identity.js';

export class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.description = description;
    this.status = status;
  }
  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}

export class OAuth {
  constructor({ store, config, services }) {
    this.store = store;
    this.config = config;
    this.services = services; // Map id -> service
    this.issuer = config.publicUrl;
  }

  // The hub is /mcp; each tool is /mcp/<id>.
  resourceUrl(serviceId) {
    return serviceId === HUB_ID ? `${this.config.publicUrl}/mcp` : `${this.config.publicUrl}/mcp/${serviceId}`;
  }

  resourceMetadataUrl(serviceId) {
    return serviceId === HUB_ID
      ? `${this.config.publicUrl}/.well-known/oauth-protected-resource/mcp`
      : `${this.config.publicUrl}/.well-known/oauth-protected-resource/mcp/${serviceId}`;
  }

  serviceOrHub(serviceId) {
    return serviceId === HUB_ID ? hubService(this.config) : this.services.get(serviceId);
  }

  // ---------- metadata ----------

  authorizationServerMetadata() {
    const base = this.config.publicUrl;
    const scopes = new Set();
    for (const s of this.services.values()) for (const k of Object.keys(s.scopes)) scopes.add(k);
    return {
      issuer: this.issuer,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [...scopes],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${base}/docs`,
    };
  }

  protectedResourceMetadata(serviceId) {
    const service = this.serviceOrHub(serviceId);
    return {
      resource: this.resourceUrl(serviceId),
      authorization_servers: [this.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: Object.keys(service.scopes),
      resource_name: service.title,
      resource_documentation: serviceId === HUB_ID ? `${this.config.publicUrl}/connect` : `${this.config.publicUrl}/add/${serviceId}`,
    };
  }

  wwwAuthenticate(serviceId, error) {
    let h = `Bearer resource_metadata="${this.resourceMetadataUrl(serviceId)}"`;
    if (error) h += `, error="${error.code}", error_description="${error.description.replace(/"/g, "'")}"`;
    return h;
  }

  // ---------- clients ----------

  register(body, ip) {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required');
    if (uris.length > 8) throw new OAuthError('invalid_redirect_uri', 'At most 8 redirect_uris');
    for (const u of uris) {
      if (typeof u !== 'string' || u.length > 512 || !isAllowedRedirect(u)) {
        throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${String(u).slice(0, 200)}`);
      }
    }
    if (this.store.all('clients').length >= MAX_CLIENTS) {
      this.store.gc();
      if (this.store.all('clients').length >= MAX_CLIENTS) throw new OAuthError('temporarily_unavailable', 'Too many registered clients', 503);
    }
    // Basic flood protection.
    const hourAgo = Date.now() - 3600000;
    const recent = this.store.find('clients', (c) => c.ip === ip && c.createdAt > hourAgo).length;
    if (ip && recent >= 50) throw new OAuthError('temporarily_unavailable', 'Too many client registrations', 429);

    const method = body.token_endpoint_auth_method || 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      throw new OAuthError('invalid_client_metadata', `token_endpoint_auth_method ${method} is not supported`);
    }
    const grantTypes = body.grant_types || ['authorization_code', 'refresh_token'];
    if (grantTypes.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
      throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
    }
    const client = {
      client_id: randomId('cli_', 16),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: grantTypes,
      response_types: ['code'],
      client_name: short(body.client_name, 100),
      client_uri: short(body.client_uri, 2000, true),
      logo_uri: short(body.logo_uri, 2000, true),
      scope: short(body.scope, 1000, true),
      software_id: short(body.software_id, 100, true),
      software_version: short(body.software_version, 100, true),
    };
    let secret;
    if (method !== 'none') {
      secret = randomToken(32);
      client.client_secret_expires_at = 0;
    }
    this.store.put('clients', client.client_id, { ...client, secretHash: secret ? sha256(secret) : null, kind: 'dcr', ip, createdAt: Date.now() });
    return { ...client, ...(secret ? { client_secret: secret } : {}) };
  }

  async resolveClient(clientId) {
    if (!clientId || typeof clientId !== 'string') throw new OAuthError('invalid_request', 'client_id is required');
    if (/^https?:\/\//.test(clientId)) {
      return fetchClientMetadata(clientId, { allowInsecure: this.config.allowInsecureClientMetadata });
    }
    const c = this.store.get('clients', clientId);
    if (!c) throw new OAuthError('invalid_client', 'Unknown client. Ask your agent app to reconnect.', 401);
    return c;
  }

  // ---------- authorize ----------

  /**
   * Validate an authorization request. Errors before the redirect URI is trusted
   * are shown to the person; after that, they are sent back to the client.
   */
  async validateAuthorizeRequest(q) {
    const client = await this.resolveClient(q.client_id).catch((err) => {
      throw Object.assign(err, { display: true });
    });
    let redirectUri = q.redirect_uri;
    if (!redirectUri) {
      if (client.redirect_uris.length !== 1) throw Object.assign(new OAuthError('invalid_request', 'redirect_uri is required'), { display: true });
      redirectUri = client.redirect_uris[0];
    }
    if (!redirectMatches(client.redirect_uris, redirectUri)) {
      throw Object.assign(new OAuthError('invalid_request', 'redirect_uri does not match the registered one'), { display: true });
    }
    const back = (error, description) => Object.assign(new OAuthError(error, description), { redirectUri, state: q.state });

    if (q.response_type !== 'code') throw back('unsupported_response_type', 'Only response_type=code is supported');
    if (!q.code_challenge) throw back('invalid_request', 'PKCE code_challenge is required');
    if ((q.code_challenge_method || 'plain') !== 'S256') throw back('invalid_request', 'code_challenge_method must be S256');

    const serviceId = this.serviceForResource(q.resource);
    if (!serviceId) {
      throw q.resource
        ? back('invalid_target', `Unknown resource ${q.resource}`)
        : back('invalid_request', 'resource is required: this gateway serves more than one tool');
    }
    return {
      client,
      service: this.serviceOrHub(serviceId),
      params: {
        client_id: q.client_id,
        redirect_uri: redirectUri,
        state: q.state,
        code_challenge: q.code_challenge,
        resource: this.resourceUrl(serviceId),
        scope: q.scope,
      },
    };
  }

  serviceForResource(resource) {
    if (!resource) return this.services.size === 1 ? [...this.services.keys()][0] : null;
    const r = String(resource).replace(/\/+$/, '');
    if (r === this.resourceUrl(HUB_ID)) return HUB_ID;
    for (const id of this.services.keys()) {
      if (r === this.resourceUrl(id)) return id;
    }
    // Some clients send the origin: that means the hub.
    if (r === this.config.publicUrl) return HUB_ID;
    return null;
  }

  createGrant({ userId, service, client, entitlement }) {
    const grant = {
      id: randomId('gr_'),
      userId,
      serviceId: service.id,
      clientId: client.client_id,
      clientName: client.client_name || null,
      clientHost: describeRedirect(client.redirect_uris[0]).host,
      entitlementId: entitlement?.id || null,
      createdAt: Date.now(),
      revokedAt: null,
      clientInfo: null,
    };
    return this.store.put('grants', grant.id, grant);
  }

  issueCode(params, grant) {
    const code = randomToken(32);
    this.store.put('codes', sha256(code), {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      resource: params.resource,
      grantId: grant.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const url = new URL(params.redirect_uri);
    url.searchParams.set('code', code);
    if (params.state !== undefined) url.searchParams.set('state', params.state);
    url.searchParams.set('iss', this.issuer);
    return url.toString();
  }

  errorRedirect(err) {
    const url = new URL(err.redirectUri);
    url.searchParams.set('error', err.error);
    if (err.description) url.searchParams.set('error_description', err.description);
    if (err.state !== undefined) url.searchParams.set('state', err.state);
    url.searchParams.set('iss', this.issuer);
    return url.toString();
  }

  // ---------- token ----------

  async authenticateClient(form, headers) {
    let clientId = form.client_id;
    let secret = form.client_secret;
    const auth = headers.authorization;
    if (auth && auth.startsWith('Basic ')) {
      const [id, sec] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id || '');
      secret = decodeURIComponent(sec || '');
    }
    const client = await this.resolveClient(clientId).catch(() => {
      throw new OAuthError('invalid_client', 'Unknown client', 401);
    });
    if (client.secretHash) {
      if (!secret || !safeEqual(sha256(secret), client.secretHash)) throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
    return client;
  }

  async token(form, headers) {
    const client = await this.authenticateClient(form, headers);
    if (form.grant_type === 'authorization_code') return this.exchangeCode(client, form);
    if (form.grant_type === 'refresh_token') return this.refresh(client, form);
    throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
  }

  exchangeCode(client, form) {
    const key = sha256(String(form.code || ''));
    const code = this.store.get('codes', key);
    if (!code || code.expiresAt < Date.now()) throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
    this.store.delete('codes', key); // one use only
    if (code.clientId !== client.client_id) throw new OAuthError('invalid_grant', 'Code was issued to another client');
    if (form.redirect_uri && form.redirect_uri !== code.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
    if (!pkceMatches(form.code_verifier, code.codeChallenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
    if (form.resource && String(form.resource).replace(/\/+$/, '') !== code.resource) {
      throw new OAuthError('invalid_target', 'resource does not match the authorization request');
    }
    const grant = this.store.get('grants', code.grantId);
    if (!grant || grant.revokedAt) throw new OAuthError('invalid_grant', 'This connection was removed');
    return this.issueTokens(grant, code.resource);
  }

  refresh(client, form) {
    const key = sha256(String(form.refresh_token || ''));
    const t = this.store.get('tokens', key);
    if (!t || t.type !== 'refresh' || t.expiresAt < Date.now()) throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired');
    if (t.clientId !== client.client_id) throw new OAuthError('invalid_grant', 'Refresh token was issued to another client');
    const grant = this.store.get('grants', t.grantId);
    if (!grant || grant.revokedAt) throw new OAuthError('invalid_grant', 'This connection was removed');
    if (grant.serviceId !== HUB_ID) {
      const ent = this.store.get('entitlements', grant.entitlementId);
      if (!ent || ent.status === 'dropped') throw new OAuthError('invalid_grant', 'This tool was removed');
    }
    this.store.delete('tokens', key); // rotate
    return this.issueTokens(grant, t.resource);
  }

  issueTokens(grant, resource) {
    const ent = this.store.get('entitlements', grant.entitlementId);
    const access = `aht_${randomToken(32)}`;
    const refresh = `ahr_${randomToken(32)}`;
    const base = { grantId: grant.id, entitlementId: grant.entitlementId, userId: grant.userId, serviceId: grant.serviceId, clientId: grant.clientId, resource };
    this.store.put('tokens', sha256(access), { ...base, type: 'access', expiresAt: Date.now() + this.config.accessTokenTtl * 1000 });
    this.store.put('tokens', sha256(refresh), { ...base, type: 'refresh', expiresAt: Date.now() + this.config.refreshTokenTtl * 1000 });
    const scope = (ent?.scopes || []).filter((s) => s !== '*').join(' ');
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtl,
      refresh_token: refresh,
      ...(scope ? { scope } : {}),
    };
  }

  // RFC 7009. Revoking any token of a connection ends that connection.
  async revoke(form, headers) {
    let client = null;
    try {
      client = await this.authenticateClient(form, headers);
    } catch {
      // Public clients may revoke without auth; we still require the token itself.
    }
    const key = sha256(String(form.token || ''));
    const t = this.store.get('tokens', key);
    if (!t) return; // per RFC 7009, unknown tokens are not an error
    if (client && t.clientId !== client.client_id) return;
    const grant = this.store.get('grants', t.grantId);
    if (grant && !grant.revokedAt) grant.revokedAt = Date.now();
    for (const [k, tok] of Object.entries(this.store.data.tokens)) if (tok.grantId === t.grantId) delete this.store.data.tokens[k];
    this.store.save();
  }

  // ---------- resource side ----------

  /** @returns {{ token, grant, entitlement } | { error: {code, description} }} */
  authenticateRequest(req, serviceId) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return { error: null };
    const t = this.store.get('tokens', sha256(h.slice(7).trim()));
    if (!t || t.type !== 'access') return { error: { code: 'invalid_token', description: 'Unknown token' } };
    if (t.expiresAt < Date.now()) return { error: { code: 'invalid_token', description: 'Token expired' } };
    if (t.serviceId !== serviceId || t.resource !== this.resourceUrl(serviceId)) {
      return { error: { code: 'invalid_token', description: 'Token was issued for another resource' } };
    }
    const grant = this.store.get('grants', t.grantId);
    if (!grant || grant.revokedAt) return { error: { code: 'invalid_token', description: 'Connection removed' } };
    if (serviceId === HUB_ID) {
      const user = this.store.get('users', grant.userId);
      if (!user) return { error: { code: 'invalid_token', description: 'Account not found' } };
      return { token: t, grant, user };
    }
    const entitlement = this.store.get('entitlements', t.entitlementId);
    if (!entitlement) return { error: { code: 'invalid_token', description: 'Entitlement not found' } };
    return { token: t, grant, entitlement };
  }
}

const MAX_CLIENTS = 10000;

// Keep strings small: client metadata is stored.
function short(v, max, dropIfLong = false) {
  if (typeof v !== 'string') return undefined;
  if (v.length > max) return dropIfLong ? undefined : v.slice(0, max);
  return v;
}

// ---------- redirect URI rules ----------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isAllowedRedirect(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  // Native apps: private-use schemes like cursor:// or vscode://
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:'].includes(u.protocol);
}

// Exact match, except loopback redirects may use any port (RFC 8252 §7.3).
export function redirectMatches(registered, uri) {
  if (registered.includes(uri)) return true;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) return false;
  return registered.some((r) => {
    try {
      const v = new URL(r);
      return v.protocol === 'http:' && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search;
    } catch {
      return false;
    }
  });
}

export function describeRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return { host: u.hostname, kind: 'web' };
    if (u.protocol === 'http:') return { host: 'an app on this computer', kind: 'loopback' };
    return { host: `${u.protocol.replace(':', '')} app`, kind: 'native' };
  } catch {
    return { host: 'unknown', kind: 'unknown' };
  }
}

export { HttpError };
