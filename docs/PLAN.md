# Agent Handshake: analysis, decisions and plan

This is the working plan behind v0.1. It is based on the build report
(Nov 1, 2026) and the product brief ("Add to my agent: three clicks, zero
pasting").

## 1. Analysis

Pasting markdown into an agent fails in four ways: no identity, no
verification, no trial or billing, and no versioning. The fix is a
handshake between a service and an agent app:

| Step | Person sees | Underneath |
|---|---|---|
| Discover | An "Add to my agent" button | Server Card + AI Catalog at `/.well-known/` |
| Connect | Three lines: access, duration, spend limit | OAuth 2.1 consent screen (PKCE, `resource`, CIMD or DCR) |
| Trial | The tool just works | Scoped, expiring, metered entitlement at the gateway |
| Keep / Pay / Drop | "Working great: upgrade?" / "Unused: remove?" | Usage ledger, labels, checkout, token revocation |

About 70% of this already exists as standards (MCP, OAuth, Server Cards,
x402). The missing 30% is the product:

1. One install link that works across agent apps.
2. A trial/entitlement layer: scoped, expiring, metered.
3. Keep/drop signals from real usage.
4. One spend policy every service respects.

## 2. Discussion: key decisions

| Decision | Choice for v1 | Why |
|---|---|---|
| Gateway or SDK | **Gateway** (reverse proxy in front of any MCP server) | Publishers change one URL. One place to enforce limits. |
| New manifest? | **No.** Use the MCP Server Card and AI Catalog, with terms in `_meta["dev.handshake/terms"]` | Don't fight the standards. |
| Where consent happens | **At the OAuth authorize step** | Every agent app that supports remote MCP + OAuth already opens this page, so the consent screen works everywhere today. |
| Who the user is | **A browser account** (signed cookie), created on first consent | No passwords, no email needed. The agent can hand the user a short-lived "manage" link. |
| Dependencies | **Zero runtime dependencies** (Node 20+) | `git clone && npm start`. Nothing to break. |
| Storage | JSON file with atomic writes | Single-instance v1. The store is one module, so Postgres can replace it. |
| Payments | Stripe Checkout (real keys) / test mode (simulated) / external (publisher's checkout + admin API) / x402 per call (beta, testnet) | Card data never touches the agent. |
| Hosts | Claude, Claude Code, Cursor, VS Code, Goose, plus "copy URL" for anything else | These work today with no partnership. Hermes and other hosts can read terms natively with the host library. |
| Namespace | `dev.handshake/terms` (spec v0.1) | Placeholder. Pick a real domain before calling the spec 1.0. |
| License | MIT | Simple and permissive. |

## 3. Plan (what ships in v0.1)

1. **Spec**: terms extension JSON Schema, gateway API, install-link format.
2. **Gateway**: OAuth 2.1 authorization server (PRM, AS metadata, DCR + CIMD,
   PKCE S256, `resource` binding, RFC 9207 `iss`, refresh rotation, RFC 7009
   revocation), MCP proxy with scope-gated tools, call caps, expiry, spend
   caps, metering, and a built-in `handshake_status` tool.
3. **Pages**: landing, install page with per-app deep links, consent screen,
   My Tools (keep / upgrade / remove + spending limits), upgrade/checkout,
   publisher dashboard.
4. **Payments**: Stripe Checkout + webhook, test mode, external mode, x402.
5. **Publisher kit**: CLI (`init`, `start`, `demo`, `validate`, `links`,
   `card`), embeddable button, README badge, `llms.txt`.
6. **Host library**: discovery, terms summary, tool pinning, usage ledger,
   keep/drop labels, spend policy, revocation.
7. **Demo**: "Lumen Video", a fictional MCP server, running behind the gateway.
8. **Brand + site**: logo, button, colors, landing site for GitHub Pages.
9. **Checks**: unit + end-to-end tests (full OAuth + MCP flow), interop test
   with the official MCP TypeScript SDK client, screenshots of every page,
   CI.

## 4. Not in v0.1 (roadmap)

- Multi-instance storage (Postgres/Redis store).
- Email or passkey sign-in for cross-device "My Tools".
- Cross-host reputation (opt-in, aggregated).
- x402 on mainnet with a production facilitator.
- Native `dev.handshake/terms` support inside hosts (Hermes first).
- Proposing the terms extension to the Server Card / AI Catalog groups.

## 5. v0.2: from handshake to aggregator

**What changed and why.** In v0.1 every tool was its own connector: a person repeated the install for each tool and had a separate trip through their agent app's settings each time. That still felt like "one more thing to paste". v0.2 makes Agent Handshake itself the one thing you connect.

| Decision | Choice |
|---|---|
| Unit of connection | The **hub** (`/mcp`): one MCP connection per person per agent app |
| How tools get added | By the **agent** (`handshake_search` → `handshake_add`) or by the **person** (one click in the catalog) |
| Who decides on trials | The person, once: "Let my agent start free trials" (default on, $0 spend limit). Paid plans always need the person. |
| How added tools show up | As `tool__action` in the same connection, plus `handshake_call` for apps that don't refresh their tool list right away |
| The "Add to my agent" button | First time: connect the hub and bring that tool along. After that: one click. |
| Positioning | "The open agent aggregator": an open protocol plus an open-source hub, with a flagship hosted hub |
| Next | Federation between hubs, a public catalog repo, reputation from usage, private hubs for companies |
