# Publisher guide

You have an MCP server. This guide puts it behind Agent Handshake so people can add it to their agent with one click, try it free, and pay for it.

## 0. How your tool reaches agents

Every gateway is also a **hub**: an agent that connects to `https://<gateway>/mcp` once can search all the tools you list, start their trials and use them. Your "Add to my agent" button (`/add/<id>`) connects a person's agent to the hub the first time, bringing your tool along, and is one click after that. People who prefer can still add your tool on its own, as a separate connector.

Give each tool good `tags` and a clear `description`: that's what agents search.

## 1. Requirements

- A **remote MCP server** that speaks Streamable HTTP (any MCP version from 2025-03-26 to 2026-07-28). If your server only speaks stdio, wrap it first with a stdio-to-HTTP bridge.
- **Node.js 20+** where the gateway runs. No other dependencies.

## 2. Create the config

```bash
npx github:larvuz2/agent-handshake init
```

This writes `handshake.config.json`. You can also write it by hand. Your editor can autocomplete it from the [`$schema`](../spec/config.schema.json).

### Full example

```json
{
  "$schema": "https://raw.githubusercontent.com/larvuz2/agent-handshake/main/spec/config.schema.json",
  "name": "Lumen Labs",
  "publicUrl": "https://agents.lumenvideo.com",
  "services": [
    {
      "id": "lumen-video",
      "name": "com.lumenvideo/mcp",
      "title": "Lumen Video",
      "description": "Turn a prompt into a short video.",
      "version": "1.4.0",
      "icon": "https://lumenvideo.com/icon.png",
      "publisher": { "name": "Lumen Labs", "domain": "lumenvideo.com", "url": "https://lumenvideo.com" },
      "upstream": {
        "url": "https://internal.lumenvideo.com/mcp",
        "headers": { "Authorization": "Bearer ${env:LUMEN_API_KEY}" }
      },
      "scopes": {
        "projects": { "description": "Create and read your video projects", "tools": ["list_projects", "create_project"] },
        "render:preview": { "description": "Render 480p previews", "tools": ["render_preview"] },
        "render:full": { "description": "Render full-quality 4K videos", "tools": ["render_full"] }
      },
      "plans": [
        { "id": "trial", "title": "Free trial", "price": 0, "durationDays": 7, "limits": { "calls": 100 }, "scopes": ["projects", "render:preview"] },
        { "id": "pro", "title": "Pro", "price": { "amount": 9, "currency": "USD", "interval": "month" }, "scopes": ["projects", "render:preview", "render:full"] },
        { "id": "free", "title": "Free", "price": 0, "limits": { "calls": 20, "period": "month" }, "scopes": ["projects"] }
      ]
    }
  ]
}
```

### Service fields

| Field | Meaning |
|---|---|
| `id` | Short id used in URLs: `/add/<id>`, `/mcp/<id>`. Lowercase letters, digits and dashes. |
| `name` | Reverse-DNS name as in the MCP Registry, with exactly one `/` (e.g. `com.lumenvideo/mcp`). |
| `title`, `description`, `version`, `icon` | What people see. The server card keeps the description to 100 characters. |
| `tags` | Words agents and people search for, e.g. `["video", "creative"]`. |
| `publisher` | `name`, `domain`, `url`. The consent screen shows a **verified** shield only when the gateway's own HTTPS address is on `domain` (for example `agents.lumenvideo.com`). Otherwise it shows the name and the gateway's host, with no claim. |
| `upstream.url` | Your MCP server. |
| `upstream.headers` | Headers the gateway sends to your server, typically your API key. Use `${env:NAME}` so secrets stay out of the file. |
| `upstream.timeoutMs` | How long to wait for your server's first byte. Default 120000. |
| `scopes` | Named groups of tools with a plain-language description. The description is what the consent screen shows. |
| `plans` | See below. With no plans, the gateway uses a 14-day free trial with all tools. |
| `statusTool` | Add the `handshake_status` tool. Default `true`. |
| `hideLockedTools` | Hide tools the current plan doesn't include. Default `true`. If `false`, they're listed and calling them returns an upgrade link. |
| `trialsPerIpPerDay` | Simple trial-abuse limit. Default 5. |

### Scopes

- A tool listed under a scope is available only on plans that include that scope.
- A tool not listed under any scope is available on **every** plan. So you only need to list the tools you want to gate.
- A plan with `"scopes": ["*"]` (or no `scopes`) includes everything.

### Plans

| Field | Meaning |
|---|---|
| `id` | `trial`, `pro`, `free`, anything lowercase. |
| `title` | Shown to people. Defaults from the price. |
| `price` | `0` for free, or `{ "amount": 9, "currency": "USD", "interval": "month" }`. Interval is `day`, `week`, `month` or `year`; leave it out for a one-time payment. |
| `durationDays` | Makes a free plan a trial that ends. |
| `limits.calls` | Call cap. |
| `limits.period` | `total` (default), `day` or `month`: when the cap resets. |
| `limits.spendUsd` | Spend cap for pay-per-call plans. Trials default to `0`. |
| `scopes` | Which scopes the plan includes. |
| `default` | `true` marks the plan new installs start on. Otherwise: the plan with id `trial`, then the first free plan, then the first plan. |
| `checkoutUrl` | Send upgrades to your own checkout page instead (see *External payments*). |
| `stripePriceId` | Use an existing Stripe Price instead of creating one from `price`. |
| `x402` | Pay per call: `{ "pricePerCall": "0.01", "network": "eip155:8453", "payTo": "0xYourWallet" }`. See *x402*. |

How plans play out:

- A new install starts on the default plan (usually the trial). One trial per person per tool.
- When the trial ends or the cap is hit, calls return a message with upgrade links instead of running.
- **Upgrade** opens a checkout page. **Keep free** moves to your free plan if you have one. **Remove** ends access.

## 3. Check and run

```bash
npx github:larvuz2/agent-handshake validate   # config + calls your server's initialize
npx github:larvuz2/agent-handshake start
npx github:larvuz2/agent-handshake links lumen-video   # install page, button, badge, deep links
```

The first start prints the **admin key** for the publisher dashboard at `/admin`. It is saved in `.handshake/secrets.json`. Set `HANDSHAKE_ADMIN_KEY` to choose your own.

## 4. Know who is calling

Every request to your server carries:

| Header | Value |
|---|---|
| `X-Handshake-User` | Stable id of the person (`usr_...`) |
| `X-Handshake-Entitlement` | Their entitlement id (`ent_...`) |
| `X-Handshake-Plan` | `trial`, `pro`, ... |
| `X-Handshake-Scopes` | Space-separated scopes |
| `X-Handshake-Client` | The agent app, if it said (e.g. `claude-ai`) |

Only trust these if your server is reachable **only through the gateway**. Require a secret header in `upstream.headers` (the demo uses `x-upstream-secret`), or keep the server on a private network.

## 5. Add the button

Script (renders a styled button where you put it):

```html
<script src="https://agents.lumenvideo.com/button.js" data-service="lumen-video" async></script>
```

Or several buttons, one script:

```html
<a data-agent-handshake="lumen-video"></a>
<script src="https://agents.lumenvideo.com/button.js" async></script>
```

Or a plain link and image, which works everywhere including GitHub READMEs:

```markdown
[![Add to my agent](https://agents.lumenvideo.com/badge/lumen-video.svg)](https://agents.lumenvideo.com/add/lumen-video)
```

## 6. Payments

`payments.mode` (or `PAYMENTS_MODE`) picks how upgrades are paid:

### Test mode (default without Stripe keys)

A simulated checkout page. Nothing is charged. A striped banner says so on every page.

### Stripe

Set `STRIPE_SECRET_KEY`. The gateway creates a Checkout Session (a subscription when the price has an interval) and confirms it when the person returns, so it works before you set up webhooks.

For cancellations and renewals, add a webhook in the Stripe Dashboard:

- Endpoint: `https://<your gateway>/webhooks/stripe`
- Events: `checkout.session.completed`, `customer.subscription.deleted`
- Put its signing secret in `STRIPE_WEBHOOK_SECRET`.

Removing a paid tool in *My tools* also cancels the Stripe subscription.

### External payments

Give a plan a `checkoutUrl` (or set `payments.mode` to `external`). Upgrades redirect there with `?entitlement=ent_...&plan=pro&return_url=...`. When the payment succeeds, activate the plan:

```bash
curl -X POST https://<gateway>/v1/entitlements/ent_.../activate \
  -H "Authorization: Bearer $HANDSHAKE_ADMIN_KEY" -H "content-type: application/json" \
  -d '{"planId":"pro","reference":"order_42"}'
```

### x402 pay per call

Add a plan with `x402`. The agent's wallet pays each call in USDC; the gateway never holds funds.

```json
{ "id": "payg", "title": "Pay per call", "x402": { "pricePerCall": "0.01", "network": "eip155:84532", "payTo": "0xYourWallet" } }
```

- Follows the x402 V2 MCP transport: payment-required results carry `PaymentRequired`; clients pay with `_meta["x402/payment"]`; successful results carry `_meta["x402/payment-response"]`.
- The gateway verifies with the facilitator before calling your server, and settles after a successful result. If settlement fails, the result is withheld.
- Default facilitator: `https://x402.org/facilitator` (**testnet only**, Base Sepolia `eip155:84532`). For mainnet (`eip155:8453`), set `X402_FACILITATOR_URL` to a production facilitator.
- Each person's spending limits (per call, day, month, set in *My tools*) are checked before any payment is accepted.
- Only agent apps with x402 support can pay. Most can't yet, so offer a subscription plan as well.

## 7. Publisher API

All endpoints take `Authorization: Bearer <admin key>`.

| Method | Path | Does |
|---|---|---|
| GET | `/v1/services` | Your services and plans |
| GET | `/v1/entitlements?service=&user=&status=` | Installs, with daily usage |
| POST | `/v1/entitlements` | `{userId, serviceId, planId}`: grant a plan |
| GET | `/v1/entitlements/{id}` | One install |
| DELETE | `/v1/entitlements/{id}` | Remove access (revokes tokens) |
| POST | `/v1/entitlements/{id}/activate` | `{planId, reference}`: after an external payment |
| POST | `/v1/entitlements/{id}/upgrade` | `{planId}`: returns `{url}` of a checkout |
| POST | `/v1/entitlements/{id}/extend` | `{days}`: extend a trial |

## 8. What people's agents see

- `tools/list` shows only the tools in their plan, plus `handshake_status`.
- `handshake_status` returns plan, days left, calls used, a usage label, and links to upgrade or manage. The links sign the person in for 24 hours, so they work in any browser.
- When a limit is hit, the call returns a short explanation and links instead of running. Apps that support MCP URL elicitation show an "open this page" prompt instead.
