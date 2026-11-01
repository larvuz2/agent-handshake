# Go live: what's left, and how to test

## Already done

- The hub (`/mcp`) with five demo tools, the seven agent tools, OAuth sign-in, free trials, limits, metering, *My tools*, the publisher dashboard.
- Payments in test mode (simulated checkout). Stripe and x402 are built and tested against mock services.
- Landing page (Netlify-ready), pitch deck, docs, Docker image, CI on every push.
- `agent-handshake check <url>`: tests a running hub the way agent apps see it.

## What needs you

These need your accounts or your decisions, so they can't be done from the repo.

| # | What | Why | How long |
|---|---|---|---|
| 1 | **Make the GitHub repo public** (if it isn't) and set the default branch to `main` (Settings → General) | `npx github:larvuz2/agent-handshake …` and one-click deploys need to read it | 1 min |
| 2 | **Deploy the hub** with the Render button in the README (or Fly, Railway, Docker) | claude.ai and ChatGPT can only reach an `https://` address. Render needs a paid instance for the data disk. | 10 min |
| 3 | **Run the check**: `npx github:larvuz2/agent-handshake check https://<your-hub>` | Confirms sign-in, discovery and pages work from the outside | 1 min |
| 4 | **Point the landing page at the hub**: set `window.AH_HUB_URL` in `site/config.js`, and connect Netlify to `main` | The "Connect your agent" buttons go to your live hub | 5 min |
| 5 | **Test with real agent apps** (below) | Confirms the full flow in Claude, Claude Code, Cursor, VS Code | 30 min |
| 6 | **Add your real tools**: the MCP server URL (and API key, if any) for Slopia, ShotForge, Capyverse tools, agentesPRO | A catalog worth connecting to on day one. Put them in `HANDSHAKE_CONFIG_JSON` on the host. | 15 min per tool |
| 7 | **Payments**: Stripe test keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`), then live keys | Real checkouts instead of the simulated one | 15 min |
| 8 | **A domain**, e.g. `hub.yourdomain.com`, set as `PUBLIC_URL` before you share links. Also decide the permanent spec namespace (now `dev.handshake/*`). | Tokens are tied to the address; changing it later disconnects people | 15 min |
| 9 | *Optional:* publish to npm to claim the name `agent-handshake` | Shorter command: `npx agent-handshake demo` | 5 min |

## Test plan

Use the deployed hub address in place of `<hub>`.

**Claude Code** (works even with a local hub)
- [ ] `claude mcp add --transport http agent-handshake <hub>/mcp`, then `/mcp` → agent-handshake → Authenticate → **Connect**
- [ ] Ask *"What time is it in Tokyo?"*: the agent searches, adds World Clock, answers

**Claude (claude.ai)**
- [ ] Settings → Connectors → Add custom connector → `<hub>/mcp` → Connect → approve the one screen
- [ ] Ask *"Make me a 15-second video of a sunrise"*: Lumen Video gets added, the project is made
- [ ] Ask *"Render it in 4K"*: you get an upgrade link → (test) checkout → 4K works
- [ ] Ask *"Show my tools"*: the list, plus a link to *My tools*

**Cursor or VS Code**
- [ ] Open `<hub>/connect` → pick the app → Install → sign in → ask for something new

**Control**
- [ ] In *My tools*, untick "Let my agent start free trials" → ask for another tool → the agent sends you an approval link → approve it
- [ ] Remove a tool in *My tools* → the agent can no longer use it
- [ ] `<hub>/admin` (admin key from the deploy logs or `HANDSHAKE_ADMIN_KEY`) shows installs and calls

**Landing**
- [ ] The Netlify site's "Connect your agent" buttons open `<hub>/connect`

## Things to watch in real apps

- **New tools showing up:** the hub tells apps the tool list changed. If an app doesn't refresh right away, the agent can still use a new tool through `handshake_call`, and a new chat shows it natively. Note which apps refresh on their own.
- **Timeouts:** claude.ai gives sign-in endpoints about 10 seconds. Keep the hub close to its tools and warm (Render and Fly can sleep on small plans).
- **Free-plan limits in agent apps:** some apps limit custom connectors by plan. Check with the account you test with.
