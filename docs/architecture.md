# Architecture

```
 WEBSITE (publisher)                          AGENT APP (host)
 ┌──────────────────────────┐                 ┌───────────────────────────┐
 │ "Add to my agent" button │──install link──▶│ Claude, Cursor, VS Code…  │
 └────────────┬─────────────┘                 │ (or a host using the kit: │
              │                               │  consent, ledger, policy) │
              ▼                               └─────────────┬─────────────┘
 ┌───────────────────────────────────────────────────────────┴──────────┐
 │ AGENT HANDSHAKE GATEWAY  (one Node process, no dependencies)          │
 │                                                                       │
 │  Discovery       /.well-known/ai-catalog.json, /mcp/<id>/server-card, │
 │                  /llms.txt, /add/<id>, /button.js, /badge/<id>.svg    │
 │  OAuth 2.1 AS    PRM, AS metadata, CIMD + DCR, authorize (= consent), │
 │                  token, revoke                                        │
 │  Entitlements    trial | active | expired | dropped; scopes, caps,    │
 │                  expiry, spend                                        │
 │  MCP proxy       /mcp/<id>: check, meter, forward, rewrite tools/list │
 │  Payments        Stripe Checkout, test, external, x402                │
 │  Pages           My tools, upgrade, publisher dashboard               │
 │  Store           data.json (atomic writes)                            │
 └───────────────────────────────┬───────────────────────────────────────┘
                                 │ your credential + X-Handshake-* headers
                                 ▼
                       ┌───────────────────┐
                       │ YOUR MCP SERVER   │
                       └───────────────────┘
```

## Source map

| File | Role |
|---|---|
| `src/server.js` | HTTP server and routes |
| `src/config.js` | Loads and checks config, env substitution, secrets |
| `src/terms.js` | Plans, scopes, the public terms document, the three-line summary |
| `src/entitlements.js` | Trial/plan state machine, limits, metering |
| `src/users.js` | Browser accounts (signed cookie), sign-in links, CSRF |
| `src/oauth/oauth.js` | Authorization server and resource-side token checks |
| `src/oauth/cimd.js` | Client ID Metadata Document fetching with SSRF guards |
| `src/mcp/proxy.js` | The MCP proxy |
| `src/mcp/messages.js` | Status tool and limit messages |
| `src/mcp/sse.js` | Streaming SSE rewrite |
| `src/billing/checkout.js` | Stripe, test and external checkout |
| `src/billing/x402.js` | x402 V2 over MCP |
| `src/discovery.js` | Server card, AI Catalog, llms.txt |
| `src/links.js` | Per-app install links |
| `src/labels.js` | Keep/drop labels |
| `src/pages/*` | Server-rendered HTML (auto-escaping template tag) |
| `host/index.js` | Host kit |

## Data model

```
users         { id, createdAt, spendPolicy }
clients       { client_id, redirect_uris, client_name, token_endpoint_auth_method, secretHash, kind: dcr }
grants        { id, userId, serviceId, clientId, clientName, entitlementId, clientInfo, capabilities, protocolVersion, revokedAt }
codes[hash]   { clientId, redirectUri, codeChallenge, resource, grantId, expiresAt }
tokens[hash]  { type: access|refresh, grantId, entitlementId, userId, serviceId, clientId, resource, expiresAt }
entitlements  { id, userId, serviceId, planId, status, scopes, limits, startedAt, expiresAt,
                period: {start, calls, spendUsd}, totals: {calls, spendUsd}, billing, droppedAt }
usage[ent][YYYY-MM-DD] { calls, ok, latencyMs, costUsd }
calls[ent]    last 50 calls { tool, ok, latencyMs, costUsd, at, client }
payments      { id, entitlementId, planId, amount, currency, provider, ref }
```

- An **entitlement** is per person per tool. It is separate from tokens, so a plan can change without signing in again.
- A **grant** is one agent app's connection to an entitlement. A person can connect the same tool from Claude and Cursor; removing the tool revokes every grant.
- CIMD clients aren't stored; their metadata is fetched and cached for an hour.

## Request flow for `tools/call`

1. Look up the bearer token (hashed). It must be an access token for this tool's `resource`, with a live grant.
2. Refresh the entitlement: expire trials, roll daily/monthly call windows.
3. `handshake_status` is answered by the gateway.
4. Check the plan: status, scope for this tool, call cap, spend cap.
5. Pay-per-call plans: check the person's spending limits, then require and verify an x402 payment.
6. Reserve the call (so parallel calls can't pass the cap), forward to the upstream with its credential and the `X-Handshake-*` headers.
7. Read the response (JSON, or SSE as it streams). On the matching result: settle x402 if needed, record success, latency and cost. If the upstream fails or the stream is cut, release the reservation.

## MCP protocol versions

The proxy is transparent, so it supports whatever your server supports. It only needs to understand three methods:

| | 2025-06-18 / 2025-11-25 | 2026-07-28 (stateless) |
|---|---|---|
| Client info | `initialize` params | `params._meta["io.modelcontextprotocol/clientInfo"]` |
| Sessions | `Mcp-Session-Id` passed through | none |
| Gateway-made results | plain result | `resultType: "complete"` added |
| Upgrade prompt | `-32042` URL elicitation error (if the client declared `elicitation.url`) | `input_required` result with a URL-mode `elicitation/create` and a signed `requestState` |
| Without URL elicitation | tool result with `isError` and links | same |
| `tools/list` caching | n/a | `cacheScope` set to `private` and `ttlMs` capped at 5 minutes, since the list depends on the plan |

All `Mcp-*` request headers are forwarded, and `Mcp-*` response headers are passed back.
