// Pages for the hub: the storefront, connecting once, one-click add, and the agent page.

import { html } from '../util/html.js';
import { priceLabel, summarizeTerms, termsExtension, upgradePlans } from '../terms.js';
import { daysLeft } from '../entitlements.js';
import { META_TOOLS } from '../hub/hub.js';
import { behind, copyField, layout, mark, serviceIcon, verifiedPublisher } from './layout.js';
import { appChooser, CHOOSER_SCRIPT, hubTargets } from './install.js';
import { csrfField, pill, termsList } from './components.js';

function statusPill(e) {
  if (!e || e.status === 'dropped') return '';
  if (e.status === 'expired') return pill('Plan ended', 'warn');
  const left = daysLeft(e);
  return pill(left !== null ? `Added · ${left} days left` : 'Added', 'good');
}

export function storefrontPage({ config, services, user, connected, mine }) {
  const cards = services.map((s) => {
    const sum = summarizeTerms(termsExtension(s, config.publicUrl));
    const e = mine.get(s.id);
    const added = e && e.status !== 'dropped';
    const paid = upgradePlans(s)[0];
    return html`<article class="ah-card hub-card" data-search="${`${s.title} ${s.description} ${(s.tags || []).join(' ')}`.toLowerCase()}">
      <div class="ah-ident">${serviceIcon(s)}<div><h3>${s.title}</h3><span class="ah-small ah-muted">${(s.tags || []).slice(0, 3).join(' · ') || s.publisher.domain || ''}</span></div></div>
      <p class="ah-muted" style="margin:12px 0">${s.description}</p>
      <div class="ah-row" style="gap:6px;margin-bottom:14px">${pill(sum.duration, 'good')}${paid ? pill(`then ${priceLabel(paid)}`, 'neutral') : ''}${statusPill(e)}</div>
      ${added
        ? html`<a class="ah-btn ah-btn--ghost ah-btn--block" href="/my">In your agent</a>`
        : html`<a class="ah-btn ah-btn--block" href="${connected ? `/hub/add/${s.id}` : `/add/${s.id}`}">${sum.plan.price === 0 && sum.plan.durationDays ? 'Try free' : 'Add to my agent'}</a>`}
    </article>`;
  });

  const body = html`
  <section class="ah-hero" style="padding-top:48px">
    <span class="ah-kicker">The open agent aggregator</span>
    <h1>Every tool for your agent.<br>One handshake.</h1>
    <p class="ah-lede">Connect your agent to ${config.name} once. Then it can find, try and use every tool here, with free trials, spend limits and one place to manage it all. No pasting, no API keys.</p>
    <div class="ah-row" style="justify-content:center">
      ${connected
        ? html`<span class="ah-pill ah-pill--good" style="padding:10px 16px;font-size:0.95rem">Your agent is connected</span><a class="ah-btn ah-btn--lg ah-btn--ghost" href="/my">My tools</a>`
        : html`<a class="ah-btn ah-btn--lg" href="/connect">Connect your agent</a><a class="ah-btn ah-btn--lg ah-btn--ghost" href="#tools">Browse ${services.length} tools</a>`}
    </div>
  </section>

  <section class="ah-section" style="padding-top:24px">
    <div class="ah-grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))">
      <div class="ah-card ah-card--soft"><h3>For people</h3><ol class="ah-steps-list" style="margin-top:6px">
        <li><b>Connect once</b> in Claude, Cursor, VS Code or another app.</li>
        <li>Click <b>Try free</b> on any tool. It's in your agent right away.</li>
        <li>Keep, upgrade or remove from <a href="/my">My tools</a>.</li></ol></div>
      <div class="ah-card ah-card--soft"><h3>For agents</h3><ol class="ah-steps-list" style="margin-top:6px">
        <li>Connect to <code>${config.publicUrl}/mcp</code> (MCP, OAuth).</li>
        <li><code>handshake_search</code> → <code>handshake_add</code> → use the tool.</li>
        <li>Free trials start on their own; paid plans need the person. <a href="/agents">Agent guide</a></li></ol></div>
    </div>
  </section>

  <section class="ah-section" id="tools">
    <div class="ah-row" style="margin-bottom:16px"><h2 style="margin:0">Tools</h2><span class="ah-spacer"></span>
      <input class="ah-input" id="hub-q" type="search" placeholder="Search tools" aria-label="Search tools" style="max-width:280px"></div>
    <div class="ah-grid" id="hub-grid">${cards}</div>
    <p class="ah-muted" id="hub-none" hidden>No tools match. Try another word.</p>
  </section>
  <script>
  (function(){var q=document.getElementById('hub-q'),cards=document.querySelectorAll('.hub-card'),none=document.getElementById('hub-none');
  q&&q.addEventListener('input',function(){var v=q.value.toLowerCase().trim(),n=0;cards.forEach(function(c){var ok=!v||c.getAttribute('data-search').indexOf(v)>=0;c.hidden=!ok;if(ok)n++;});none.hidden=n>0;});})();
  </script>`;
  return layout({ config, body, user });
}

export function connectPage({ config, user, connected, pending }) {
  const url = `${config.publicUrl}/mcp`;
  const body = html`
  <div class="ah-dialog">
    <div class="ah-ident"><span class="ah-icon" style="background:var(--ah-bg-soft)">${mark({ size: 40 })}</span><div><h1 style="font-size:1.6rem">Connect your agent</h1><span class="ah-muted">Once. Then every tool on ${config.name} is one click away.</span></div></div>
    ${connected ? html`<div class="ah-note ah-note--good" style="margin-top:16px">This browser already connected an agent. Connect another app below, or go to <a href="/my">My tools</a>.</div>` : ''}
    ${pending ? html`<div class="ah-note" style="margin-top:16px">${pending.title} will be added when you approve.</div>` : ''}
    <ul class="ah-terms">
      <li><span class="ah-ti ah-ti--access">✓</span><div><b>Find, try and use tools for you</b><span>Your agent searches and adds tools when you ask for something new</span></div></li>
      <li><span class="ah-ti ah-ti--time">⏱</span><div><b>Free trials start on their own</b><span>You can switch this off and approve each tool yourself</span></div></li>
      <li><span class="ah-ti ah-ti--spend">$</span><div><b>Spend limit: $0. Paid plans always need your OK.</b><span>Payment only ever happens on a checkout page</span></div></li>
    </ul>
    <h3 style="margin-top:8px">Choose your agent app</h3>
    ${appChooser(hubTargets(config), url, 'hub')}
  </div>
  <div style="margin-top:16px">${behind(html`Your app adds <code>${url}</code> as one remote MCP server and signs in with OAuth 2.1 + PKCE. Tools you add appear inside it as <code>tool__action</code>, each metered against its own plan.`)}</div>
  ${CHOOSER_SCRIPT}`;
  return layout({ config, title: 'Connect your agent', body, user, narrow: true });
}

// One-click add for a connected person, or the approval page for a link from the agent.
export function hubAddPage({ config, service, user, csrf, token, existing, error }) {
  const sum = summarizeTerms(termsExtension(service, config.publicUrl));
  const added = existing && existing.status !== 'dropped' && existing.status !== 'expired';
  const body = html`
  <div class="ah-dialog">
    <div class="ah-ident">${serviceIcon(service)}<div><h1 style="font-size:1.5rem">Add ${service.title} to your agent</h1>${verifiedPublisher(service, config)}</div></div>
    ${service.description ? html`<p class="ah-muted" style="margin:14px 0 0">${service.description}</p>` : ''}
    ${error ? html`<div class="ah-note ah-note--bad" style="margin-top:14px">${error}</div>` : ''}
    ${termsList(sum)}
    ${added
      ? html`<div class="ah-note ah-note--good">${service.title} is already in your agent. <a href="/my">My tools</a></div>`
      : html`<form method="post" action="/hub/add/${service.id}">
          ${token ? html`<input type="hidden" name="t" value="${token}">` : csrfField(csrf)}
          <div class="ah-row" style="flex-wrap:nowrap"><a class="ah-btn ah-btn--lg ah-btn--ghost" href="/" style="flex:1">Cancel</a>
          <button class="ah-btn ah-btn--lg" style="flex:2" autofocus>${sum.plan.price === 0 && sum.plan.durationDays ? 'Start free trial' : 'Add to my agent'}</button></div>
        </form>`}
  </div>
  <div style="margin-top:16px">${behind(html`Your agent is already connected to ${config.name}, so ${service.title} shows up inside that connection. Nothing to install in your app.`)}</div>`;
  return layout({ config, title: `Add ${service.title}`, body, user, narrow: true });
}

export function hubAddedPage({ config, service, user }) {
  const body = html`
  <div class="ah-dialog ah-center">
    <span class="ah-pill ah-pill--good">Added</span>
    <h1 style="font-size:1.5rem;margin-top:12px">${service.title} is in your agent</h1>
    <p class="ah-muted">Go back to your agent and ask for what you need${service.description ? html`: <i>${service.description.split(/[.:]/)[0].toLowerCase()}</i>` : ''}. If your app doesn't show it yet, start a new chat.</p>
    <div class="ah-row" style="justify-content:center"><a class="ah-btn ah-btn--ghost" href="/#tools">More tools</a><a class="ah-btn" href="/my">My tools</a></div>
  </div>`;
  return layout({ config, title: 'Added', body, user, narrow: true });
}

export function agentsPage({ config, services }) {
  const url = `${config.publicUrl}/mcp`;
  const body = html`
  <h1 style="font-size:2rem">For AI agents</h1>
  <p class="ah-lede" style="text-align:left;margin:0 0 20px">If you are an AI agent: this page tells you how to get access to ${services.length} tools through one connection. If you are a person, <a href="/connect">connect your agent here</a>.</p>
  <div class="ah-card ah-stack">
    <h3>1. Connect (the person approves once)</h3>
    <p>Remote MCP server, Streamable HTTP, OAuth 2.1:</p>${copyField(url)}
    <p class="ah-small ah-muted">Discovery: <a href="/.well-known/ai-catalog.json">/.well-known/ai-catalog.json</a> · <a href="/mcp/server-card">server card</a> · <a href="/llms.txt">llms.txt</a></p>
    <h3>2. Find and add tools</h3>
    <ul class="ah-steps-list">${META_TOOLS.map((t) => html`<li><code>${t.name}</code>: ${t.description}</li>`)}</ul>
    <h3>3. Rules</h3>
    <ul class="ah-steps-list">
      <li>Free trials and free plans start right away when the person allows it. Otherwise <code>handshake_add</code> returns a link for the person.</li>
      <li>Never collect payment details in chat. Paid plans use the link from <code>handshake_upgrade</code>.</li>
      <li>When a limit is hit, the result explains it and includes links. Show them to the person.</li>
      <li>Only remove tools when the person asks.</li>
    </ul>
  </div>
  <h2 style="margin-top:32px">Tools available</h2>
  <div class="ah-tablewrap"><table class="ah-table"><thead><tr><th>id</th><th>What it does</th><th>Starts with</th></tr></thead><tbody>
    ${services.map((s) => html`<tr><td><code>${s.id}</code></td><td style="white-space:normal">${s.description}</td><td>${summarizeTerms(termsExtension(s, config.publicUrl)).duration}</td></tr>`)}
  </tbody></table></div>`;
  return layout({ config, title: 'For agents', body });
}
