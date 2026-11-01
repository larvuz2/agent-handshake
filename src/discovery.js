// Discovery documents, in the formats the ecosystem already uses:
//   Server Card (SEP-2127)  GET /mcp/{id}/server-card   application/mcp-server-card+json
//   AI Catalog (draft)      GET /.well-known/ai-catalog.json   application/ai-catalog+json
//   llms.txt                GET /llms.txt
// Trial and pricing terms ride along in the card's _meta under "dev.handshake/terms".

import { TERMS_KEY, priceLabel, summarizeTerms, termsExtension } from './terms.js';
import { hostName } from './hub/identity.js';
import { META_TOOLS } from './hub/hub.js';

export const HUB_KEY = 'dev.handshake/hub';

export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
export const SERVER_CARD_TYPE = 'application/mcp-server-card+json';
export const AI_CATALOG_TYPE = 'application/ai-catalog+json';

export function serverCardUrl(config, service) {
  return `${config.publicUrl}/mcp/${service.id}/server-card`;
}

export function serverCard(config, service) {
  const card = {
    $schema: SERVER_CARD_SCHEMA,
    name: service.name,
    version: service.version,
    description: truncate(service.description || service.title, 100),
    title: service.title,
    remotes: [{ type: 'streamable-http', url: `${config.publicUrl}/mcp/${service.id}` }],
    _meta: { [TERMS_KEY]: termsExtension(service, config.publicUrl) },
  };
  if (service.websiteUrl) card.websiteUrl = service.websiteUrl;
  if (service.icon) card.icons = [{ src: service.icon }];
  return card;
}

// The hub's own card: one MCP server that aggregates every tool here.
export function hubServerCard(config, services) {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: `${hostName(config.publicUrl)}/hub`,
    version: '0.2.0',
    description: truncate(`One connection to ${services.length} tools. Find, try and use them, with free trials.`, 100),
    title: config.name,
    websiteUrl: config.publicUrl,
    remotes: [{ type: 'streamable-http', url: `${config.publicUrl}/mcp` }],
    _meta: {
      [HUB_KEY]: {
        specVersion: '0.2',
        catalog: `${config.publicUrl}/.well-known/ai-catalog.json`,
        agentGuide: `${config.publicUrl}/agents`,
        tools: services.map((s) => ({ id: s.id, title: s.title, card: serverCardUrl(config, s) })),
        agentTools: META_TOOLS.map((t) => t.name),
        connect: `${config.publicUrl}/connect`,
        manage: `${config.publicUrl}/my`,
      },
    },
  };
}

export function aiCatalog(config, services) {
  const host = new URL(config.publicUrl).hostname;
  return {
    specVersion: '1.0',
    host: {
      displayName: config.name,
      identifier: host,
      documentationUrl: `${config.publicUrl}/`,
    },
    entries: [
      {
        identifier: `urn:air:${host}:mcp:hub`,
        type: SERVER_CARD_TYPE,
        url: `${config.publicUrl}/mcp/server-card`,
        displayName: `${config.name} (all tools, one connection)`,
        description: truncate(`Connect once to get ${services.length} tools: ${services.map((s) => s.title).join(', ')}.`, 280),
        version: '0.2.0',
        tags: ['mcp', 'agent-handshake', 'hub', 'aggregator'],
      },
      ...services.map((s) => ({
      identifier: `urn:air:${s.publisher.domain || host}:mcp:${s.id}`,
      type: SERVER_CARD_TYPE,
      url: serverCardUrl(config, s),
      displayName: s.title,
      description: truncate(s.description || s.title, 280),
      version: s.version,
      ...(s.publisher.domain ? { publisher: { identifier: s.publisher.domain, displayName: s.publisher.name, identityType: 'dns' } } : {}),
      tags: ['mcp', 'agent-handshake', ...(s.tags || [])],
    })),
    ],
  };
}

export function llmsTxt(config, services) {
  const lines = [
    `# ${config.name}`,
    '',
    `> An agent aggregator: ${services.length} tools for AI agents through one connection, with free trials, spend limits and one place to manage them.`,
    '> Powered by Agent Handshake (https://github.com/larvuz2/agent-handshake).',
    '',
    '## If you are an AI agent',
    '',
    `1. Connect to the MCP server ${config.publicUrl}/mcp (Streamable HTTP, OAuth 2.1). The person approves once.`,
    '2. When the person asks for something you cannot do, call handshake_search, then handshake_add, then use the tool (handshake_call works right away).',
    '3. Free trials start on their own within the limits the person set. Paid plans need the person: give them the link from handshake_upgrade. Never collect payment details in chat.',
    `4. Full guide: ${config.publicUrl}/agents`,
    '',
    '## If you are a person',
    '',
    `- Connect your agent once: ${config.publicUrl}/connect`,
    `- Browse tools: ${config.publicUrl}/`,
    `- Manage your tools: ${config.publicUrl}/my`,
    '',
    '## Tools',
    '',
  ];
  for (const s of services) {
    const terms = termsExtension(s, config.publicUrl);
    const sum = summarizeTerms(terms);
    lines.push(`- [${s.title}](${config.publicUrl}/add/${s.id}): ${s.description || ''}`.trim());
    lines.push(`  - MCP server (Streamable HTTP, OAuth): ${config.publicUrl}/mcp/${s.id}`);
    lines.push(`  - Starts with: ${sum.lines.join('; ')}`);
    const paid = s.plans.filter((p) => p.price !== 0 || p.x402);
    if (paid.length) lines.push(`  - Paid plans: ${paid.map((p) => `${p.title} (${priceLabel(p)})`).join(', ')}`);
    lines.push(`  - Server card: ${serverCardUrl(config, s)}`);
  }
  lines.push('', '## Discovery', '', `- AI Catalog: ${config.publicUrl}/.well-known/ai-catalog.json`, `- Hub server card: ${config.publicUrl}/mcp/server-card`, '');
  return lines.join('\n');
}

function truncate(s, n) {
  s = String(s || '');
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}
