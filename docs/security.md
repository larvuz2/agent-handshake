# Security

This is where "paste a markdown file into your agent" fails, and where a handshake can do better. Each risk below lists what v0.1 does about it.

| Risk | What Agent Handshake does |
|---|---|
| **Fake publisher** | The consent screen shows the domain the agent app is connecting to. A **verified** shield appears only when the gateway's own HTTPS address is on the publisher's declared domain; otherwise the publisher name is shown with no claim. The host kit flags server cards whose MCP URL is on a different origin than the card. |
| **Tool descriptions change after approval** ("rug pull") | The host kit's `toolsHash()` pins what the model sees; apps can ask again when it changes. The gateway also controls which tools are listed per plan. |
| **Prompt injection through tool output** | Tool output passes through unchanged and should be treated as untrusted by the agent app. The gateway's own messages are plain text with links. |
| **Secrets in install links** | Never. Links carry a name and URL only. Agent apps sign in with OAuth; your upstream credential stays in the gateway (`upstream.headers`, from env vars). |
| **Over-broad access** | Trials get only the scopes you list for them, shown in plain language on the consent screen. Tools outside a plan are hidden and refused. |
| **Token theft or replay** | Opaque access tokens (1 hour) and rotating refresh tokens (90 days), stored only as SHA-256 hashes. Each token is bound to one tool (`resource`, RFC 8707) and is rejected anywhere else. PKCE S256 is required. `iss` is sent on every authorization response (RFC 9207). |
| **Authorization code interception** | Codes are single-use, expire in 10 minutes, are bound to the client, redirect URI, PKCE challenge and resource. A failed exchange burns the code. |
| **Open redirects / bad redirect URIs** | Exact redirect matching (loopback may change port, RFC 8252). Only HTTPS, loopback HTTP, or app schemes (`cursor://`); `javascript:`, `data:`, `file:` are refused. Invalid authorization requests show an error page and never redirect, since anyone can register a client (RFC 9700). |
| **SSRF through Client ID Metadata Documents** | HTTPS only, no redirects, 5 s timeout, 64 KB limit while streaming, and the hostname must not resolve to a private, loopback or link-local address (relaxed only when the gateway itself runs on localhost). The fetch connects to the exact address that was checked, so DNS rebinding can't swap it. |
| **Consent forgery (CSRF, clickjacking)** | The consent form carries a signed, 15-minute request token and a per-browser CSRF token. Pages send `X-Frame-Options: DENY` and `frame-ancestors 'none'`. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS. |
| **Trial abuse** | One trial per person per tool; a returning person resumes their old plan. A per-network limit on new trials (`trialsPerIpPerDay`, default 5), using proxy headers only when `TRUST_PROXY` says so. Some abuse is accepted by design. |
| **Runaway spend** | Trials have a $0 spend limit. Pay-per-call plans check the plan's spend cap and the person's own limits (per call, day, month) before accepting any payment. Agent apps can enforce the same policy locally with the host kit. |
| **Payment details exposure** | Subscriptions are paid on a checkout page in the browser (Stripe Checkout or yours). The agent never sees card details. x402 payments are signed by the agent's wallet and settled by a facilitator; the gateway never holds funds. Stripe webhooks are signature-checked with a 5-minute window. |
| **Links handed out by the agent** | Upgrade links open one tool's upgrade page only (scoped token, 24 hours) and never sign the browser in. The *My tools* link expires in an hour and needs a button press on a confirmation page; if the browser already holds a different list of tools, the page says so before switching. |
| **Resetting limits by switching plans** | The free trial is only for new installs. "Moving" to the plan you're on is refused, so it can't reset call counts. Removing a paid subscription ends it; reconnecting doesn't bring it back. A publisher's revoke is permanent. |
| **Billing drift** | Each Stripe Checkout Session and test ticket applies once. Any plan change cancels the running subscription and clears it, so a late webhook can't touch the next plan. |
| **Metering bypass** | Request ids must be strings or integers and unique within a batch, so every result is matched to its call. Calls and their price are reserved before anything is awaited, so parallel calls can't pass a cap. If the client hangs up mid-stream, the call still counts and a verified payment is settled. After a plan ends, only listing and the upgrade message work. |
| **Storage flooding** | Client registration bodies are capped at 16 KB, with at most 8 short redirect URIs; unused clients are deleted after a week; at most 10,000 registered clients. |
| **Upstream impersonation of users** | `X-Handshake-User` and related headers are only meaningful if your MCP server accepts traffic from the gateway alone. Require a secret header in `upstream.headers`. |
| **Gateway sees usage** | Usage is stored per install on your gateway and shown to the person in *My tools* and to you in the dashboard. Nothing is shared with other gateways. |
| **Public discovery documents** | Server cards, the AI catalog and `llms.txt` contain no secrets, internal URLs or user data. The upstream URL is never published. |

## Things to know

- **Single instance.** v0.1 stores data in one JSON file. Run one instance per data folder.
- **Browser accounts.** People are identified by a signed cookie. If they clear cookies, they can get back in through a link from `handshake_status`. Email or passkey sign-in is on the roadmap.
- **x402 is new.** Use the testnet facilitator until you have tested your setup end to end.
- **Admin key.** It gives full access to the dashboard and API. Keep it in a secret store. Changing `HANDSHAKE_ADMIN_KEY` signs out every dashboard session.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
