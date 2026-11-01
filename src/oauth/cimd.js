// Client ID Metadata Documents: the client_id is an HTTPS URL that serves the
// client's metadata as JSON. We fetch it, check it, and cache it briefly.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const cache = new Map(); // url -> { client, until }
const TTL = 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

function makeError(description) {
  const err = new Error(description);
  err.error = 'invalid_client';
  err.description = description;
  err.status = 400;
  return err;
}

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export async function fetchClientMetadata(clientId, { allowInsecure = false } = {}) {
  const hit = cache.get(clientId);
  if (hit && hit.until > Date.now()) return hit.client;

  let url;
  try {
    url = new URL(clientId);
  } catch {
    throw makeError('client_id is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) throw makeError('client_id URL must use https');
  if (url.hash || url.username || url.password) throw makeError('client_id URL must not contain a fragment or credentials');

  if (!allowInsecure) {
    const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
    if (addrs.length === 0) throw makeError(`Cannot resolve ${url.hostname}`);
    if (addrs.some((a) => isPrivateAddress(a.address))) throw makeError('client_id points to a private network address');
  }

  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
  } catch (err) {
    throw makeError(`Could not fetch client metadata: ${err.message}`);
  }
  if (!res.ok) throw makeError(`Client metadata returned HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw makeError('Client metadata document is too large');
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw makeError('Client metadata is not JSON');
  }
  if (doc.client_id !== clientId) throw makeError('client_id in the metadata document does not match its URL');
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) throw makeError('Client metadata has no redirect_uris');
  const method = doc.token_endpoint_auth_method || 'none';
  if (method !== 'none') throw makeError(`token_endpoint_auth_method ${method} is not supported for metadata-document clients yet`);

  const client = {
    client_id: clientId,
    redirect_uris: doc.redirect_uris.map(String),
    client_name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : url.hostname,
    client_uri: doc.client_uri,
    logo_uri: doc.logo_uri,
    token_endpoint_auth_method: 'none',
    secretHash: null,
    kind: 'cimd',
    verifiedHost: url.hostname,
  };
  cache.set(clientId, { client, until: Date.now() + TTL });
  return client;
}

export function clearClientMetadataCache() {
  cache.clear();
}
