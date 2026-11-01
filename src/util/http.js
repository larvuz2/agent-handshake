// Small HTTP helpers on top of node:http. No framework.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MAX_BODY = 4 * 1024 * 1024; // 4 MB

export async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readForm(req) {
  const raw = (await readBody(req, 256 * 1024)).toString('utf8');
  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  if (type === 'application/json') {
    try {
      const obj = JSON.parse(raw || '{}');
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export async function readJson(req, limit) {
  const raw = (await readBody(req, limit)).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, headers);
  res.end(body);
}

export function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data, null, 2), {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
}

export function sendHtml(res, status, html, headers = {}) {
  send(res, status, html, {
    'content-type': 'text/html; charset=utf-8',
    'x-frame-options': 'DENY',
    'content-security-policy':
      // No form-action: the consent form redirects to the agent app (https://, loopback or app:// schemes).
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer',
    ...headers,
  });
}

export function redirect(res, location, status = 302, headers = {}) {
  send(res, status, '', { location, 'cache-control': 'no-store', ...headers });
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function cookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id, payment-signature, x-payment',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version, www-authenticate, payment-required, payment-response',
  'access-control-max-age': '86400',
};

// Who is the client? Proxy headers are trusted only when told to, because anyone
// can send them. TRUST_PROXY: unset/false = use the socket address; true = the
// right-most X-Forwarded-For entry (added by your proxy); a header name such as
// fly-client-ip or cf-connecting-ip = that header. Fly.io is detected.
export function clientIp(req) {
  const socket = req.socket?.remoteAddress || 'unknown';
  let mode = process.env.TRUST_PROXY;
  if (mode === undefined && process.env.FLY_APP_NAME) mode = 'fly-client-ip';
  if (mode === undefined && (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT)) mode = 'true';
  if (!mode || mode === 'false') return socket;
  if (mode === 'true') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return fwd.length ? fwd[fwd.length - 1] : socket;
  }
  const v = req.headers[mode.toLowerCase()];
  return v ? String(v).split(',')[0].trim() : socket;
}
