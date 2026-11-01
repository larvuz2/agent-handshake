# Agent apps and the host kit

Agent Handshake works with today's agent apps without any change on their side. Apps that want to go further can read the terms natively with the host kit.

## Install links per app

The install page (`/add/<id>`) builds these for you. They carry a name and a URL only, never a secret. Formats were checked against each vendor's docs in November 2026.

| App | Link or command | Then |
|---|---|---|
| Claude (claude.ai, Desktop, mobile) | `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=<name>&connectorUrl=<url>` | Click **Add**, then **Connect**. Needs a public HTTPS gateway. |
| Claude Code | `claude mcp add --transport http <id> <url>` | `/mcp`, pick the server, **Authenticate** |
| Cursor | `cursor://anysphere.cursor-deeplink/mcp/install?name=<id>&config=<base64 {"url":...}>` | Click **Needs login** |
| VS Code | `vscode:mcp/install?<urlencoded {"name","type":"http","url"}>` or `code --add-mcp '<json>'` | Allow the sign-in |
| Goose | `goose://extension?url=<url>&type=streamable_http&id=<id>&name=<name>` | Sign in when asked |
| LM Studio | `lmstudio://add_mcp?name=<id>&config=<base64 {"url":...}>` | Sign in when asked |
| ChatGPT | No link. Developer mode → create a connector → paste the URL → OAuth | Needs a public HTTPS gateway |

Notes:

- GitHub strips custom-scheme links (`cursor://`, `vscode:`). In READMEs, link to the install page instead. It's an `https://` link that offers every app.
- Cursor's OAuth callback listens on `localhost:8787`. That's why the gateway defaults to port **7410**.

## How agent apps sign in

The gateway is a standard OAuth 2.1 authorization server for MCP:

- `401` with `WWW-Authenticate: Bearer resource_metadata="..."` (RFC 9728)
- Authorization server metadata at `/.well-known/oauth-authorization-server` (and `/.well-known/openid-configuration`)
- **Client ID Metadata Documents** (`client_id_metadata_document_supported: true`, with `none` auth) for Claude, Claude Code, VS Code, ChatGPT and Goose
- **Dynamic Client Registration** at `/oauth/register` for Cursor and older clients
- PKCE S256 required, `resource` bound to the tool, `iss` in every redirect (RFC 9207)
- Loopback redirects match on any port (RFC 8252); app schemes like `cursor://` are allowed
- Refresh tokens rotate; `/oauth/revoke` (RFC 7009) ends the connection

## Native support: the host kit

An agent app can do the whole handshake itself, without the install page: read the terms, show its own consent screen, track usage locally, and enforce one spend policy across every tool.

```js
import { discover, toolsHash, Ledger, SpendPolicy, revoke } from 'agent-handshake/host';

// 1. Discover. Accepts a site, an install page, an MCP URL, a server card, or agent-handshake://
const [tool] = await discover('https://agents.lumenvideo.com/add/lumen-video');
tool.summary.lines;  // ['Create and read your video projects · Render 480p previews', 'Free for 7 days · up to 100 calls', 'Spend limit: $0. No card needed.']
tool.sameOrigin;     // true if the card and the server live on the same site
tool.warnings;       // [] or plain-language problems to show

// 2. Connect with your normal MCP OAuth flow, using tool.mcpUrl.

// 3. Pin what the model sees. Ask again if it changes (rug-pull protection).
const pinned = toolsHash((await client.listTools()).tools);

// 4. Keep a local ledger and show keep/drop labels.
const ledger = new Ledger('./ledger.json');
ledger.addServer('lumen-video');
ledger.record('lumen-video', { tool: 'create_project', ok: true, latencyMs: 820 });
ledger.label('lumen-video');  // { text: 'Working great', tone: 'good', suggestion: 'upgrade' }

// 5. One spend policy for every paid call.
const policy = new SpendPolicy({ default: { perCallUsd: 0.05, perDayUsd: 2, perMonthUsd: 20 }, requireHumanAboveUsd: 1, allowNetworks: ['eip155:8453'] });
policy.check({ service: 'com.lumenvideo/mcp', amountUsd: 0.01, network: 'eip155:8453', asset: 'USDC', ledger, ledgerId: 'lumen-video' });
// { decision: 'allow' } | { decision: 'ask', reason } | { decision: 'deny', reason }

// 6. Drop: revoke, then forget the server.
await revoke({ revocationEndpoint: tool.terms.uninstall.revocationEndpoint, token: refreshToken, clientId });
ledger.removeServer('lumen-video');
```

The spend policy also accepts the snake_case YAML shape from the build report (`spend_policy.default.per_call_usd`, ...).

### A custom install scheme

Apps that read the terms natively can register:

```
agent-handshake://install?card=<URL-encoded server card URL>
```

`parseInstallLink()` understands it. Publishers can then offer it next to the per-app links.

## Hermes: suggested integration

Based on the Hermes MCP skill documentation (not its source code), these are the gaps and how the kit fills them:

| Gap | Fix |
|---|---|
| Servers live in static config; adding or removing needs a restart | Hot-add/remove in the MCP manager |
| Auth is a static header | OAuth client with PRM discovery, CIMD, PKCE, `resource`, refresh and revoke |
| No install entry point | Handle `hermes://mcp/install?...` and `agent-handshake://install?card=...`; call `discover()` |
| No consent UI | Render `summary.lines` and `warnings` |
| No usage ledger | `Ledger`, plus labels in the UI |
| No spend policy | `SpendPolicy.check()` before signing any x402 payment |
| Tool descriptions can change after approval | Store `toolsHash()` at install; ask again if it changes |
