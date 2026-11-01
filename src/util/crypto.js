import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomId(prefix = '', bytes = 12) {
  return prefix + randomBytes(bytes).toString('base64url');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256b64url(input) {
  return createHash('sha256').update(input).digest('base64url');
}

export function hmac(secret, data) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Signed, expiring, URL-safe blob: base64url(json).sig
export function sign(secret, payload, ttlSeconds) {
  const body = { ...payload };
  if (ttlSeconds) body.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${data}.${hmac(secret, data)}`;
}

export function verify(secret, token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const data = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!safeEqual(sig, hmac(secret, data))) return null;
  let body;
  try {
    body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

// PKCE S256 check (RFC 7636)
export function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return safeEqual(sha256b64url(verifier), challenge);
}

// Stable JSON for hashing (sorted keys).
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
