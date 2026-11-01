# Deploy

The gateway is one Node process with no dependencies. It keeps its data in one folder (`DATA_DIR`). Run **one instance** per data folder.

## Settings

| Variable | What it does | Default |
|---|---|---|
| `PUBLIC_URL` | The gateway's public address. Used as the OAuth issuer and in every link. Must be HTTPS for claude.ai and ChatGPT. | Detected on Render, Railway and Fly; otherwise `http://localhost:<PORT>` |
| `PORT` | Port to listen on | `7410` |
| `DATA_DIR` | Where data and generated secrets are kept | `.handshake` |
| `HANDSHAKE_CONFIG_JSON` | The whole config as JSON (handy on hosting platforms) | |
| `HANDSHAKE_CONFIG` | Path to the config file | `handshake.config.json` |
| `HANDSHAKE_ADMIN_KEY` | Key for `/admin` and the publisher API | Generated, saved in `DATA_DIR/secrets.json` |
| `HANDSHAKE_SECRET` | Signs cookies and links | Generated, saved in `DATA_DIR/secrets.json` |
| `PAYMENTS_MODE` | `test`, `stripe` or `external` | `stripe` if `STRIPE_SECRET_KEY` is set, else `test` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Real payments | |
| `X402_FACILITATOR_URL` | x402 facilitator | `https://x402.org/facilitator` (testnet) |
| `TRUST_PROXY` | How to find the visitor's IP (for the trial limit). `true`: the right-most `X-Forwarded-For` entry your proxy adds. A header name (e.g. `cf-connecting-ip`): that header. | Socket address; `fly-client-ip` on Fly; `true` on Render and Railway |

Changing `PUBLIC_URL` later breaks existing connections, because tokens are bound to it. Pick it before you share links.

## Try it from claude.ai in 2 minutes (tunnel)

claude.ai and ChatGPT need to reach the gateway over HTTPS. A free Cloudflare quick tunnel is the fastest way:

```bash
# terminal 1
npx cloudflared tunnel --url http://localhost:7410
# copy the https://<random>.trycloudflare.com address it prints

# terminal 2
npx github:larvuz2/agent-handshake demo --public-url https://<random>.trycloudflare.com
```

Then open `https://<random>.trycloudflare.com/add/lumen-video` and choose **Claude**.

## Docker

```bash
docker build -t agent-handshake .

# the demo
docker run -p 7410:7410 -v handshake-data:/data agent-handshake

# your config
docker run -p 7410:7410 -v handshake-data:/data \
  -v $PWD/handshake.config.json:/app/handshake.config.json:ro \
  -e PUBLIC_URL=https://agents.example.com \
  -e LUMEN_API_KEY=... \
  agent-handshake
```

The image runs `agent-handshake auto`: your config if it finds one, otherwise the demo.

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/larvuz2/agent-handshake)

The blueprint (`render.yaml`) uses a Docker web service with a 1 GB disk at `/data`. Disks need a paid instance type. `PUBLIC_URL` is detected from `RENDER_EXTERNAL_URL`. It starts the demo; paste your config into `HANDSHAKE_CONFIG_JSON` to run your own tools.

## Fly.io

```bash
fly launch --copy-config --no-deploy
fly volumes create handshake_data --size 1
fly secrets set HANDSHAKE_CONFIG_JSON="$(cat handshake.config.json)"
fly deploy
```

`PUBLIC_URL` defaults to `https://<app>.fly.dev`. Set it if you use a custom domain.

## Railway

Create a project from this repo (Railway builds the Dockerfile), add a volume mounted at `/data`, generate a domain, and set `HANDSHAKE_CONFIG_JSON`. `PUBLIC_URL` is detected from `RAILWAY_PUBLIC_DOMAIN`.

## A plain server

```bash
git clone https://github.com/larvuz2/agent-handshake /opt/agent-handshake
cd /srv/my-gateway            # holds handshake.config.json
PUBLIC_URL=https://agents.example.com node /opt/agent-handshake/bin/agent-handshake.js start
```

Put it behind any HTTPS reverse proxy (Caddy, nginx). For streamed MCP responses, turn off response buffering (the gateway already sends `X-Accel-Buffering: no` for nginx).

## Stripe

1. Set `STRIPE_SECRET_KEY` (use a test key `sk_test_...` first).
2. In the Stripe Dashboard, add a webhook to `https://<gateway>/webhooks/stripe` for `checkout.session.completed` and `customer.subscription.deleted`. Set `STRIPE_WEBHOOK_SECRET` to its signing secret.
3. Upgrade from *My tools*. You land on Stripe Checkout, and the plan switches when you return.

## x402

The default facilitator (`https://x402.org/facilitator`) is **testnet only**: use network `eip155:84532` (Base Sepolia) and test USDC. For real money, use network `eip155:8453` (Base) and set `X402_FACILITATOR_URL` to a production facilitator (Coinbase CDP's hosted facilitator, another provider, or your own).

## Backups

Everything lives in `DATA_DIR`:

- `data.json`: people, installs, tokens (hashed), usage
- `secrets.json`: the signing secret and admin key

Back up both files together. The store writes atomically (temp file and rename).

## Scaling

v0.1 keeps state in memory and in `data.json`, so it runs as **one instance**. That handles a lot of traffic: the proxy is streaming and the per-call bookkeeping is small. For more than one instance, replace `src/store.js` with a shared database (Postgres or Redis). It's one module with a small interface.
