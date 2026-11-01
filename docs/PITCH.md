# Agent Handshake: the pitch

**The deck:** [pitch-deck.pdf](pitch-deck.pdf) (14 slides). To edit it, change [deck/deck.html](deck/deck.html), open it in Chrome and choose Print → Save as PDF. Fill in the amount and the team details first.

## In one sentence

**Agent Handshake is the open agent aggregator: connect your AI agent once, and it can find, try and pay for any tool, with free trials, spend limits and one place to manage them.**

Shorter: *one handshake gives your agent every tool.*

## The 30-second version

> Agents get their abilities from tools, through a standard called MCP. But adding a tool today means pasting instructions or API keys into your agent, one tool at a time, with no trial, no billing and no way to see what's used. Tool makers can't reach agents, and people can't control what agents spend.
>
> Agent Handshake fixes distribution. You connect your agent to it once. When you ask for something new, your agent searches the catalog, starts a free trial and uses the tool. You keep what works, pay for what you need, and remove the rest from one page. Tool makers list once and reach every connected agent, with trials and payments built in.
>
> It's an open protocol on top of the standards that already won (MCP, OAuth, x402) and an open-source hub anyone can run. We run the flagship hub and take a share of what tools earn through it.

## The problem

| Who | Today |
|---|---|
| **People** | Paste a block of text or an API key into the agent, one tool at a time. No trial. No idea what's used. No clean uninstall. |
| **Agents** | Can only use what someone wired up in advance. They can't find or add a tool when the person asks for something new. |
| **Tool makers** | Build an MCP server, then have no distribution, no trial flow and no way to charge agents. Every agent app installs differently. |

## The solution

One hub, three audiences:

- **People** connect their agent once (Claude, Cursor, VS Code, ChatGPT…). Then they add any tool with one click, or let the agent add free trials on its own. Spend limit $0 by default. One *My tools* page to upgrade or remove.
- **Agents** get one MCP connection with seven tools: search, add, call, info, my tools, upgrade, remove. When the person asks for something they can't do, they find a tool and start its trial.
- **Tool makers** list their MCP server unchanged. They get trials, scopes, metering, Stripe or x402 payments, and a dashboard, and they reach every agent connected to the hub.

See it: `npx github:larvuz2/agent-handshake demo`, then connect Claude Code and ask *"what time is it in Tokyo?"*.

## Is it a protocol or a product?

Both, like email: an open standard anyone can implement, plus the best place to use it.

- **Protocol (open, MIT):**
  - The trial and price terms in MCP Server Cards (`dev.handshake/terms`).
  - The hub card (`dev.handshake/hub`).
  - One install link that works across agent apps.
  - An entitlements API.
  - All of it sits on MCP, OAuth 2.1, the AI Catalog and x402.
- **Product:** the hub. It's open source so anyone can run one, but people want one place for all their tools. We run the flagship hub with the biggest catalog.

## Why now

- **MCP won.** Claude, ChatGPT, Cursor, VS Code and Goose all connect to remote MCP servers with OAuth. The 2026-07-28 spec made servers stateless, which makes hubs cheap to run.
- **Agents can pay.** x402 (now under the Linux Foundation) lets agents pay per call in stablecoins.
- **Discovery standards are forming.** MCP Server Cards and the AI Catalog are new, and nobody owns the layer between "found a tool" and "it's working and paid for".

The plumbing exists. The trial, billing, aggregation and spend-control layer doesn't. That's the gap.

## Business model

| Stream | How it works | When |
|---|---|---|
| **Take rate** | A share of subscriptions and pay-per-call volume that flows through the flagship hub | From the first paid tool |
| **Hosted gateways** | Tool makers pay for hosting, custom domains, analytics and conversion tools | Months 3–6 |
| **Private hubs** | Companies run an approved-tools hub for their employees' agents, with policy, audit and central billing | Months 6–12 |

The take rate, prices and fees are open questions. Benchmark them against app stores and payment platforms before fixing numbers.

## Why we win

1. **Network effect.** More tools bring more connected agents. More agents bring more tool makers.
2. **We hold the relationship.** The person's spend policy, entitlements and *My tools* page live in the hub. Agents keep coming back to the same front door.
3. **Usage data becomes ranking.** Real calls, success rates and keep/drop decisions make search better than any static directory.
4. **Neutral and open.** Platform stores serve one app each. Tool makers want one listing for every agent app, and an open protocol makes us the safe choice.
5. **Shipped and tested.** v0.2 works today with the official MCP SDK client: the hub, trials, metering, Stripe, x402 and both MCP versions.

## Competition (verify before pitching)

| Category | Examples | Our difference |
|---|---|---|
| Registries | Official MCP Registry | They list servers. We handle install, trial, billing, limits and uninstall, and agents can add tools themselves. |
| App-specific directories | Directories inside individual agent apps | One app each. We work across all of them. |
| Integration platforms | Hosted MCP and integration services | They host integrations. We are an open, cross-host marketplace layer with built-in trials and spend control. |

## How we get users (go-to-market)

**1. Supply first, so connecting is instantly worth it.**
- Launch with 30–50 useful tools: our own (Slopia, ShotForge, Capyverse tools, agentesPRO playbooks), free everyday utilities, and partner MCP servers.
- A hub with five tools is a demo. A hub with fifty is a reason to connect.

**2. Every tool maker's audience becomes ours.**
- Each tool's "Add to my agent" button sends people to the hub.
- They come for one tool and stay for the catalog: the first connect brings that tool along, and every tool after that is one click.

**3. Agent-native distribution.**
- List the hub itself as an MCP server in the official MCP Registry and in the agent apps' directories.
- Publish `llms.txt` and the AI Catalog, so agents that browse the web recommend it.

**4. Open source as a funnel.**
- "List your tool in 5 minutes" (`npx … init`), templates, and a public catalog repo where makers add tools with a pull request.
- Developers who run their own hub become contributors and partners.

**5. Content that shows the magic.**
- Short videos: "My agent added a video tool by itself and made this in 30 seconds."
- Spanish-language markets as a wedge (agentesPRO): less competition, strong communities.

**What we measure:**
- Connected agents.
- Tools added per agent.
- Weekly active tools per agent.
- Trial-to-paid conversion.
- Revenue through the hub.

## Milestones (targets, not traction)

| By | Goal |
|---|---|
| Day 30 | Flagship hub live, 30 tools, first 100 connected agents |
| Day 90 | 1,000 connected agents, 10 tool makers with paid plans, first take-rate revenue |
| Day 180 | Federation (hubs list each other's tools), public catalog repo, first private-hub customer |

## The ask

*[Amount]* to:
- run the flagship hub;
- sign the first 50 tools;
- bring the spec (`dev.handshake/terms`, `dev.handshake/hub`) to the MCP and AI Catalog groups;
- reach the Day 180 milestones.

Fill in the amount and use of funds.

## Risks, and the answers

| Risk | Answer |
|---|---|
| Agent apps build their own stores | Tool makers still want one listing for all apps, and people want one place for all their tools. Our protocol plugs into any store. |
| Standards change | Everything we add is a namespaced extension on top of the standards, so it moves with them. |
| Trust and safety | $0 trial spend, scopes, human approval for paid plans, spend limits, tool pinning, and Remove that revokes access instantly. |
| Payments regulation | Stripe Checkout and x402 facilitators settle payments. The hub never holds funds. Get legal review before taking a cut. |

## 10-slide outline

1. **Title:** Agent Handshake: every tool for your agent, one handshake.
2. **Problem:** "paste this into your agent": no trial, no billing, no uninstall, one tool at a time.
3. **Demo:** the agent finds, adds and uses a tool in one conversation (the landing page demo).
4. **How it works:** connect once, search, add, use, with keep/pay/remove.
5. **Three audiences:** people, agents and tool makers, with the value for each.
6. **Why now:** MCP everywhere, agent payments live, discovery standards forming.
7. **Business model:** take rate, hosted gateways, private hubs.
8. **Why we win:** network effect, the hub holds the relationship, usage-based ranking, open and neutral.
9. **Go-to-market and milestones:** supply first, makers' buttons, agent-native distribution.
10. **Team and ask.**
