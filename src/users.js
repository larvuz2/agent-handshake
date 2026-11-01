// People are identified by a signed browser cookie, created the first time they
// approve a tool. No passwords. The agent can hand out a short-lived "manage"
// link (signed) that logs the person into My Tools on any browser.

import { cookie, parseCookies } from './util/http.js';
import { hmac, randomId, safeEqual, sha256, sign, verify } from './util/crypto.js';

const COOKIE = 'ah_uid';
const ADMIN_COOKIE = 'ah_admin';
const YEAR = 365 * 86400;

export class Users {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.secure = config.publicUrl.startsWith('https://');
  }

  sealUid(uid) {
    return `${uid}.${hmac(this.config.secret, `uid:${uid}`)}`;
  }

  uidFromRequest(req) {
    const v = parseCookies(req)[COOKIE];
    if (!v) return null;
    const i = v.lastIndexOf('.');
    if (i < 1) return null;
    const uid = v.slice(0, i);
    return safeEqual(v.slice(i + 1), hmac(this.config.secret, `uid:${uid}`)) ? uid : null;
  }

  // The user record exists only after they approve something.
  current(req) {
    const uid = this.uidFromRequest(req);
    return uid ? this.store.get('users', uid) : null;
  }

  // Returns a uid for this browser, setting the cookie if needed.
  ensureUid(req, res) {
    const uid = this.uidFromRequest(req);
    if (uid) return uid;
    const fresh = randomId('usr_');
    this.setCookie(res, fresh);
    return fresh;
  }

  setCookie(res, uid) {
    appendHeader(res, 'set-cookie', cookie(COOKIE, this.sealUid(uid), { maxAge: YEAR, secure: this.secure }));
  }

  getOrCreate(uid) {
    return this.store.get('users', uid) || this.store.put('users', uid, { id: uid, createdAt: Date.now(), spendPolicy: defaultSpendPolicy() });
  }

  // Full sign-in to My tools. Only ever used behind a confirmation page.
  loginToken(uid, ttlSeconds = 3600) {
    return sign(this.config.secret, { k: 'login', uid }, ttlSeconds);
  }

  consumeLoginToken(token) {
    const body = verify(this.config.secret, token);
    return body?.k === 'login' ? body.uid : null;
  }

  // A link that opens one tool's upgrade page, and nothing else. This is what the
  // agent hands out, so holding a tool token never means holding the whole account.
  entitlementToken(uid, entitlementId, ttlSeconds = 24 * 3600) {
    return sign(this.config.secret, { k: 'ent', uid, e: entitlementId }, ttlSeconds);
  }

  readEntitlementToken(token, entitlementId) {
    const body = verify(this.config.secret, token);
    return body?.k === 'ent' && body.e === entitlementId ? body.uid : null;
  }

  // ---- publisher admin session ----
  // The cookie is tied to the current admin key, so rotating the key signs everyone out.
  adminKeyTag() {
    return sha256(`admin:${this.config.adminKey}`).slice(0, 16);
  }

  isAdmin(req) {
    const v = parseCookies(req)[ADMIN_COOKIE];
    const body = v && verify(this.config.secret, v);
    return Boolean(body?.k === 'admin' && body.kt === this.adminKeyTag());
  }

  adminCookie() {
    return cookie(ADMIN_COOKIE, sign(this.config.secret, { k: 'admin', kt: this.adminKeyTag() }, 12 * 3600), { maxAge: 12 * 3600, secure: this.secure });
  }

  csrf(uid, purpose = '') {
    return hmac(this.config.secret, `csrf:${uid}:${purpose}`);
  }

  checkCsrf(uid, token, purpose = '') {
    return Boolean(uid && token && safeEqual(token, this.csrf(uid, purpose)));
  }
}

export function defaultSpendPolicy() {
  // Applies to agent-paid calls (x402) across every service on this gateway.
  return { perCallUsd: 0.1, perDayUsd: 1, perMonthUsd: 10 };
}

export function appendHeader(res, name, value) {
  const prev = res.getHeader(name);
  if (!prev) res.setHeader(name, value);
  else res.setHeader(name, [].concat(prev, value));
}
