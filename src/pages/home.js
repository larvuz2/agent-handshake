import { html } from '../util/html.js';
import { summarizeTerms, termsExtension } from '../terms.js';
import { behind, layout, mark, serviceIcon } from './layout.js';
import { pill } from './components.js';

export function homePage({ config, services, user }) {
  const cards = services.map((s) => {
    const sum = summarizeTerms(termsExtension(s, config.publicUrl));
    return html`<article class="ah-card">
      <div class="ah-ident">${serviceIcon(s)}<div><h3>${s.title}</h3><span class="ah-small ah-muted">${s.publisher.domain || s.publisher.name}</span></div></div>
      <p class="ah-muted" style="margin:14px 0">${s.description}</p>
      <div class="ah-row" style="margin-bottom:16px">${pill(sum.duration, 'good')}</div>
      <a class="ah-add" href="/add/${s.id}">${mark({ mono: true, size: 28 })}Add to my agent</a>
    </article>`;
  });

  const body = html`
  <section class="ah-hero">
    <span class="ah-kicker">Open source · MCP · OAuth</span>
    <h1>Add to my agent.<br>Three clicks, zero pasting.</h1>
    <p class="ah-lede">Give your AI agent a new tool the way you add an app: see what it can do, try it free, keep it, pay for it, or remove it. No copying, no API keys.</p>
    <div class="ah-row" style="justify-content:center">
      <a class="ah-btn ah-btn--lg" href="#tools">Browse tools</a>
      <a class="ah-btn ah-btn--lg ah-btn--ghost" href="${user ? '/my' : 'https://github.com/larvuz2/agent-handshake'}">${user ? 'My tools' : 'Run your own gateway'}</a>
    </div>
  </section>

  <section class="ah-section" id="tools">
    <h2>Tools on this gateway</h2>
    <p class="ah-muted">Each one starts as a free trial with a $0 spend limit.</p>
    <div class="ah-grid">${cards}</div>
  </section>

  <section class="ah-section">
    <h2>How it works</h2>
    <div class="ah-steps">
      <div class="ah-step"><div class="ah-step-n">1</div><h3>Click one button</h3><p class="ah-muted">On any website, click <b>Add to my agent</b> and pick your agent app. There's nothing to copy.</p>
        ${behind(html`The site publishes a <code>server card</code> and <code>ai-catalog.json</code>. The button opens the right install link for Claude, Cursor, VS Code, Goose and more.`)}</div>
      <div class="ah-step"><div class="ah-step-n">2</div><h3>Read three lines, start the trial</h3><p class="ah-muted">What it can access, how long it's free, and the spend limit. Then <b>Start free trial</b>.</p>
        ${behind(html`OAuth 2.1 with PKCE. Your agent gets a scoped, expiring trial token bound to this one tool.`)}</div>
      <div class="ah-step"><div class="ah-step-n">3</div><h3>Keep it, pay for it, or remove it</h3><p class="ah-muted"><b>My tools</b> shows what's working and what's unused. Upgrade or remove in one click.</p>
        ${behind(html`Every call is metered at the gateway. Upgrades go through a checkout page (Stripe) or <code>x402</code> per call. Removing revokes the token.`)}</div>
    </div>
  </section>`;
  return layout({ config, body, user });
}
