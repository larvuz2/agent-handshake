# Contributing

Thanks for helping. Agent Handshake is small on purpose: one Node process, no runtime dependencies.

## Setup

```bash
git clone https://github.com/larvuz2/agent-handshake && cd agent-handshake
npm test            # no install needed
npm run demo        # gateway + demo tools on http://localhost:7410
npm install && npm run test:interop   # optional: official MCP SDK client against the gateway
```

## Ground rules

- **No runtime dependencies.** Dev dependencies for tests are fine.
- **Plain JavaScript (ESM)**, Node 20+. JSDoc for types where it helps.
- **Every behavior has a test.** End-to-end tests in `test/flow.test.js` drive a real OAuth + MCP flow; add to them.
- **Words people see are short and plain.** Technical detail goes in "Behind the scenes" boxes and docs.
- **Follow the standards.** If MCP, OAuth or x402 already defines something, use it. New fields go under `dev.handshake/*`.
- **Security first.** No secrets in links. Tokens are hashed. Anything from a client, an upstream or a web page is untrusted.

## Good first contributions

- A Postgres store (`src/store.js` has a small interface)
- More agent apps on the install page (with a link to their docs)
- Translations of the consent screen and My tools
- A Python or Go version of the host kit

## Pull requests

Describe what changed and why, include tests, and run `npm test`. For changes to the spec (`spec/`), open an issue first so we can discuss it.
