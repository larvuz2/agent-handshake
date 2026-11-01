import { html, raw, toString } from '../util/html.js';

let markCounter = 0;

// The brand mark: two linked loops (the service and the agent).
export function mark({ mono = false, size = 34, className = '' } = {}) {
  const id = `ahm${++markCounter}`;
  const a = mono ? '#ffffff' : '#2B59FF';
  const b = mono ? '#bfe9ff' : '#12B886';
  return raw(`<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><defs><clipPath id="${id}"><rect x="22" y="36" width="20" height="16"/></clipPath></defs><rect x="6.5" y="19" width="33" height="26" rx="13" fill="none" stroke="${a}" stroke-width="7"/><rect x="24.5" y="19" width="33" height="26" rx="13" fill="none" stroke="${b}" stroke-width="7"/><rect x="6.5" y="19" width="33" height="26" rx="13" fill="none" stroke="${a}" stroke-width="7" clip-path="url(#${id})"/></svg>`);
}

const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  wallet: '<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
};

export function icon(name, size = 18) {
  return raw(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`,
  );
}

export function serviceIcon(service, small = false) {
  const cls = small ? 'ah-icon ah-icon--sm' : 'ah-icon';
  if (service.icon) return html`<span class="${cls}"><img src="${service.icon}" alt=""></span>`;
  const letter = (service.title || '?').trim().charAt(0).toUpperCase();
  return html`<span class="${cls}" aria-hidden="true">${letter}</span>`;
}

// The publisher domain in the config is a claim. We only show the shield when the
// gateway itself is served from that domain, which the browser has verified (TLS).
export function publisherVerified(service, config) {
  const domain = service.publisher.domain;
  const host = new URL(config.publicUrl).hostname;
  return Boolean(domain && config.publicUrl.startsWith('https://') && (host === domain || host.endsWith(`.${domain}`)));
}

export function verifiedPublisher(service, config) {
  const host = new URL(config.publicUrl).hostname;
  if (publisherVerified(service, config)) {
    return html`<span class="ah-verified">${icon('shield', 15)} <b>${service.publisher.domain}</b> · verified, served from its own domain</span>`;
  }
  const { name, domain } = service.publisher;
  return html`<span class="ah-verified">${name}${domain && !name.includes(domain) ? ` · ${domain}` : ''} · served by ${host}</span>`;
}

export function behind(text) {
  return html`<div class="ah-behind"><strong>Behind the scenes</strong>${text}</div>`;
}

export function copyField(value, label = 'Copy') {
  return html`<div class="ah-code"><code>${value}</code><button type="button" class="ah-btn ah-btn--ghost ah-btn--sm" data-copy="${value}">${icon('copy', 15)} ${label}</button></div>`;
}

const COPY_SCRIPT = `
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
    var t = b.innerHTML; b.textContent = 'Copied'; setTimeout(function () { b.innerHTML = t; }, 1400);
  });
});`;

export function layout({ config, title, body, user, narrow = false, nav = true, testBanner = true, head = '' }) {
  const testMode = config.payments.mode === 'test' && testBanner;
  return toString(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · ` : ''}${config.name}</title>
<link rel="icon" href="/assets/mark.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/handshake.css">
<link rel="ai-catalog" href="/.well-known/ai-catalog.json" type="application/ai-catalog+json">
${raw(head)}
</head>
<body>
${testMode ? html`<div class="ah-testmode">Test mode: payments are simulated. Set <code>STRIPE_SECRET_KEY</code> to take real payments.</div>` : ''}
<header class="ah-header"><div class="ah-wrap">
  <a class="ah-brand" href="/">${mark()}<span>${config.name}</span></a>
  ${nav ? html`<nav class="ah-nav"><a href="/my">My tools</a><a href="https://github.com/larvuz2/agent-handshake">GitHub</a></nav>` : ''}
</div></header>
<main class="ah-main"><div class="${narrow ? 'ah-narrow' : 'ah-wrap'}">
${body}
</div></main>
<footer class="ah-footer"><div class="ah-wrap">
  <span>Powered by <a href="https://github.com/larvuz2/agent-handshake">Agent Handshake</a>, open source (MIT)</span>
  <span class="ah-spacer"></span>
  <a href="/.well-known/ai-catalog.json">AI Catalog</a><a href="/llms.txt">llms.txt</a>${user ? html`<a href="/my">My tools</a>` : ''}
</div></footer>
<script>${raw(COPY_SCRIPT)}</script>
</body>
</html>`);
}

export function errorPage(config, { title = 'Something went wrong', message, status }) {
  return layout({
    config,
    title,
    narrow: true,
    body: html`<div class="ah-dialog"><h2>${title}</h2><p class="ah-muted">${message}</p>${status ? html`<p class="ah-small ah-muted">Error ${status}</p>` : ''}<a class="ah-btn ah-btn--ghost" href="/">Go home</a></div>`,
  });
}
