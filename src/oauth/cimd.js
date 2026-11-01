// Client ID Metadata Documents: the client_id is an HTTPS URL that serves the
// client's metadata as JSON. We fetch it, check it, and cache it briefly.
//
// The fetch connects to the exact address we checked (no second DNS lookup, so
// DNS rebinding can't reach a private address), follows no redirects, stops
// after 64 KB, and times out after 5 seconds.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

const cache = new Map(); // url -> { client, until }
const TTL = 60 * 60 * 1000;
const MAX_CACHE = 500;
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
  const v = String(ip).toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

// GET a URL from one fixed IP address, with a size cap.
function pinnedGet(url, address, family) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'agent-handshake-gateway/0.1' },
        lookup: (_host, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        timeout: 5000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(makeError(`Client metadata returned HTTP ${res.statusCode}`));
        }
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(makeError('Client metadata document is too large'));
          } else chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(makeError('Client metadata took too long to load')));
    req.on('error', (err) => reject(err.description ? err : makeError(`Could not fetch client metadata: ${err.message}`)));
    req.end();
  });
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

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw makeError(`Cannot resolve ${url.hostname}`);
  if (!allowInsecure && addrs.some((a) => isPrivateAddress(a.address))) throw makeError('client_id points to a private network address');

  const text = await pinnedGet(url, addrs[0].address, addrs[0].family);
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
    redirect_uris: doc.redirect_uris.map(String).slice(0, 20),
    client_name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : url.hostname,
    client_uri: doc.client_uri,
    logo_uri: doc.logo_uri,
    token_endpoint_auth_method: 'none',
    secretHash: null,
    kind: 'cimd',
    verifiedHost: url.hostname,
  };
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(clientId, { client, until: Date.now() + TTL });
  return client;
}

export function clearClientMetadataCache() {
  cache.clear();
}
