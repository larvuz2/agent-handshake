// Discovery documents, in the formats the ecosystem already uses:
//   Server Card (SEP-2127)  GET /mcp/{id}/server-card   application/mcp-server-card+json
//   AI Catalog (draft)      GET /.well-known/ai-catalog.json   application/ai-catalog+json
//   llms.txt                GET /llms.txt
// Trial and pricing terms ride along in the card's _meta under "dev.handshake/terms".

import { TERMS_KEY, priceLabel, summarizeTerms, termsExtension } from './terms.js';

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

export function aiCatalog(config, services) {
  const host = new URL(config.publicUrl).hostname;
  return {
    specVersion: '1.0',
    host: {
      displayName: config.name,
      identifier: host,
      documentationUrl: `${config.publicUrl}/`,
    },
    entries: services.map((s) => ({
      identifier: `urn:air:${s.publisher.domain || host}:mcp:${s.id}`,
      type: SERVER_CARD_TYPE,
      url: serverCardUrl(config, s),
      displayName: s.title,
      description: truncate(s.description || s.title, 280),
      version: s.version,
      ...(s.publisher.domain ? { publisher: { identifier: s.publisher.domain, displayName: s.publisher.name, identityType: 'dns' } } : {}),
      tags: ['mcp', 'agent-handshake'],
    })),
  };
}

export function llmsTxt(config, services) {
  const lines = [
    `# ${config.name}`,
    '',
    '> Tools you can add to an AI agent with one click. Each one has a free trial, a spend limit, and an uninstall button.',
    '> Powered by Agent Handshake (https://github.com/larvuz2/agent-handshake).',
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
  lines.push('', '## For agents', '', `- Discovery: ${config.publicUrl}/.well-known/ai-catalog.json`, `- Manage installed tools: ${config.publicUrl}/my`, '');
  return lines.join('\n');
}

function truncate(s, n) {
  s = String(s || '');
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}
