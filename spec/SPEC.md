# Agent Handshake specification, v0.1 (draft)

**Status:** draft, November 2026. The namespace `dev.handshake` is a placeholder until the project settles on a domain; the version will reach 1.0 only after that.

This document defines:

1. **Terms**: trial, plans and limits for an MCP server, published in its Server Card.
2. **Install links**: one link that works across agent apps.
3. **Gateway behavior**: how limits are enforced and signaled over MCP.
4. **Gateway API**: managing entitlements.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Terms

### 1.1 Where they live

Terms are an extension inside an [MCP Server Card](https://modelcontextprotocol.io/seps/2127-mcp-server-cards), under the `_meta` key **`dev.handshake/terms`**. Agent apps already fetch the card during discovery, so one request returns identity, endpoint and terms.

The card SHOULD be served at `<streamable-http-url>/server-card` with media type `application/mcp-server-card+json`, and listed in the site's AI Catalog at `/.well-known/ai-catalog.json`.

Note: the official MCP Registry drops unknown `_meta` keys. Terms belong on the publisher's own card; the registry stays a discovery pointer.

### 1.2 Shape

JSON Schema: [`terms.schema.json`](terms.schema.json).

```json
{
  "specVersion": "0.1",
  "gateway": "https://agents.lumenvideo.com",
  "install": "https://agents.lumenvideo.com/add/lumen-video",
  "manage": "https://agents.lumenvideo.com/my",
  "defaultPlan": "trial",
  "scopes": {
    "projects": { "description": "Create and read your video projects" },
    "render:full": { "description": "Render full-quality 4K videos" }
  },
  "plans": [
    {
      "id": "trial",
      "title": "Free trial",
      "price": 0,
      "durationDays": 7,
      "limits": { "calls": 100, "spendUsd": 0 },
      "scopes": ["projects"]
    },
    {
      "id": "pro",
      "title": "Pro",
      "price": { "amount": 9, "currency": "USD", "interval": "month" },
      "scopes": ["projects", "render:full"],
      "checkoutUrl": "https://agents.lumenvideo.com/upgrade?service=lumen-video&plan=pro"
    },
    {
      "id": "payg",
      "title": "Pay per call",
      "price": 0,
      "x402": { "pricePerCall": "0.01", "asset": "USDC", "network": "eip155:8453" },
      "scopes": ["*"]
    }
  ],
  "uninstall": { "revocationEndpoint": "https://agents.lumenvideo.com/oauth/revoke" }
}
```

| Field | Meaning |
|---|---|
| `specVersion` | `"0.1"` |
| `gateway` | Origin that enforces the terms |
| `install` | Universal install page (§2) |
| `manage` | Where the person manages the tool |
| `defaultPlan` | Plan a new install starts on |
| `scopes` | Scope name → `{ description }`. Descriptions are written for people and shown as-is. |
| `plans[].price` | `0`, or `{ amount, currency, interval? }`; `interval` is `day`, `week`, `month` or `year`; none means one-time |
| `plans[].durationDays` | The plan ends after this many days (a trial) |
| `plans[].limits` | `calls` (cap), `period` (`total`, `day`, `month`), `spendUsd` (cap on agent payments) |
| `plans[].scopes` | Scopes included; `"*"` means all |
| `plans[].checkoutUrl` | Where a person upgrades to this plan |
| `plans[].x402` | Pay per call: `pricePerCall` (USD, decimal string), `asset`, `network` (CAIP-2) |
| `uninstall.revocationEndpoint` | RFC 7009 endpoint; revoking any token ends that connection |

Consumers MUST ignore fields they don't understand. A free plan with `durationDays` and no `limits.spendUsd` MUST be treated as `spendUsd: 0`.

### 1.3 The three lines

Agent apps SHOULD show, before connecting:

1. **Access**: the default plan's scope descriptions (or "Use all of its tools").
2. **Duration and price**: e.g. "Free for 7 days · up to 100 calls", "$9/mo", "$0.01 per call, paid by your agent".
3. **Spend limit**: e.g. "Spend limit: $0. No card needed."

`summarizeTerms()` in `agent-handshake/terms` is the reference implementation.

## 2. Install links

### 2.1 Universal install page

`https://<gateway>/add/<id>` is an ordinary HTTPS page that shows the three lines and offers each agent app's own install link (Claude, Cursor, VS Code, Goose, LM Studio, a Claude Code command, or the raw URL). It works in READMEs and anywhere custom schemes are stripped.

`https://<gateway>/add/<id>?format=json` returns `{ service, mcpUrl, serverCard, terms, summary, targets[] }` for apps that want to build their own UI.

### 2.2 Custom scheme (for apps with native support)

```
agent-handshake://install?card=<URL-encoded server card URL>
```

An app that registers this scheme fetches the card, reads the terms, shows its own consent screen, and connects with OAuth. Install links MUST NOT carry secrets.

## 3. Gateway behavior

### 3.1 Authorization

The gateway is an OAuth 2.1 authorization server as required by the MCP authorization spec: Protected Resource Metadata (RFC 9728), authorization server metadata (RFC 8414), Client ID Metadata Documents and/or Dynamic Client Registration (RFC 7591), PKCE S256, resource indicators (RFC 8707), and `iss` in authorization responses (RFC 9207).

The **consent page at the authorization endpoint shows the three lines**. Approving it creates (or resumes) the entitlement. One trial per person per tool.

### 3.2 Entitlements

An entitlement has a `status`: `trial`, `active`, `expired` or `dropped`. On every `tools/call` the gateway MUST check, in order: status, scope for the tool, call cap, spend cap. Tokens carry no plan data, so plan changes apply on the next call.

### 3.3 Listing tools

`tools/list` SHOULD include only tools the plan allows. Gateways SHOULD add a read-only tool named **`handshake_status`** that reports the plan, time left, calls used, a usage label and links to upgrade and manage. When the list depends on the plan, stateless (2026-07-28) results MUST NOT be marked `cacheScope: "public"`.

### 3.4 When a limit is reached

The gateway MUST NOT forward the call. It answers with one of:

- **2026-07-28 clients that declared `elicitation.url`**: an `input_required` result whose `inputRequests` has one `elicitation/create` request in URL mode pointing at the upgrade page, plus an integrity-protected `requestState`. On retry, the gateway re-checks the entitlement; a declined or cancelled response gets the tool result below.
- **2025-11-25 clients that declared `elicitation.url`**: a `-32042` error with `data.elicitations: [{ mode: "url", elicitationId, url, message }]`.
- **Everyone else**: a tool result with `isError: true` and a short text that names the limit and lists links (upgrade options, a free plan if any, manage).

Payment details MUST only be collected on a web page, never through the agent.

### 3.5 Pay per call (x402)

For plans with `x402`, the gateway follows the x402 V2 MCP transport:

1. Without `params._meta["x402/payment"]`: tool result with `isError: true`, `structuredContent` = `PaymentRequired`, and `content[0].text` = the same JSON.
2. With a payment: verify with the facilitator, forward the call, settle on success, and return `_meta["x402/payment-response"]`. If settlement fails, withhold the tool output and return `PaymentRequired` again.

Before accepting a payment, the gateway MUST check the plan's `spendUsd` and SHOULD check the person's own spending limits. Agent apps SHOULD enforce their own spend policy before signing.

### 3.6 Upstream identity

When forwarding, a gateway SHOULD send `X-Handshake-User`, `X-Handshake-Entitlement`, `X-Handshake-Plan` and `X-Handshake-Scopes` so the server can serve per-person data.

## 4. Gateway API

Publisher endpoints, authenticated with `Authorization: Bearer <admin key>`:

```
GET    /v1/services
GET    /v1/entitlements?service=&user=&status=
POST   /v1/entitlements                    { userId, serviceId, planId }
GET    /v1/entitlements/{id}
DELETE /v1/entitlements/{id}               drop: revoke tokens, end access
POST   /v1/entitlements/{id}/activate      { planId, reference }   after an external payment
POST   /v1/entitlements/{id}/upgrade       { planId }  ->  { url }  a checkout URL
POST   /v1/entitlements/{id}/extend        { days }
```

## 5. Usage labels

Gateways and apps SHOULD use the same labels so people see the same thing everywhere:

| Label | Rule (v0.1) |
|---|---|
| Having trouble | 5+ calls in 7 days and under 50% succeeded |
| Expensive | cost per successful call above a threshold (default $0.25) |
| Working great | 10+ calls in 7 days and over 90% succeeded |
| Just added | no calls yet, installed under 3 days ago |
| Unused | no calls in 14 days (suggest removing) |
| Try more | under 3 calls in 7 days |
| In use | anything else |

## 6. Open questions

- A permanent namespace and domain.
- Signed terms (detached JWS over the card), so terms can be verified when served by a third party.
- Cross-gateway reputation that stays private by default.
- An x402 binding for `input_required` results.
