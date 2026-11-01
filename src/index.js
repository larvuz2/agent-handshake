// Agent Handshake: public API.
export { createGateway } from './server.js';
export { buildConfig, readConfigFile } from './config.js';
export { TERMS_KEY, TERMS_SPEC_VERSION, normalizeService, termsExtension, summarizeTerms, priceLabel, planAllowsTool } from './terms.js';
export { installTargets, installLinks, handshakeSchemeLink } from './links.js';
export { label, labelFromDays, windowStats, LABELS } from './labels.js';
export { serverCard, aiCatalog, llmsTxt } from './discovery.js';
export { badgeSvg } from './button.js';
