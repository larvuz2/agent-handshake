import { html, jsonForScript } from '../util/html.js';
import { installTargets } from '../links.js';
import { summarizeTerms, termsExtension } from '../terms.js';
import { behind, copyField, layout, serviceIcon, verifiedPublisher } from './layout.js';
import { termsList } from './components.js';

export function installInfo(config, service) {
  const mcpUrl = `${config.publicUrl}/mcp/${service.id}`;
  const terms = termsExtension(service, config.publicUrl);
  return {
    service: { id: service.id, name: service.name, title: service.title, description: service.description, publisher: service.publisher, tags: service.tags },
    mcpUrl,
    hubUrl: `${config.publicUrl}/mcp`,
    serverCard: `${mcpUrl}/server-card`,
    terms,
    summary: summarizeTerms(terms).lines,
    targets: installTargets({ name: service.id, url: mcpUrl, title: service.title, description: service.description }),
    hubTargets: hubTargets(config),
  };
}

export function hubTargets(config) {
  const name = config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent-handshake';
  return installTargets({ name, url: `${config.publicUrl}/mcp`, title: config.name, description: 'Every tool here through one connection' });
}

// The "pick your agent app" chooser. `prefix` keeps several on one page apart.
export function appChooser(targets, url, prefix = 'a') {
  const tiles = targets.map(
    (t, i) =>
      html`<button type="button" class="ah-host" data-host="${t.id}" data-group="${prefix}" aria-pressed="${i === 0 ? 'true' : 'false'}"><b>${t.name}</b><span>${t.note || ' '}</span></button>`,
  );
  const panels = targets.map(
    (t, i) => html`<div class="ah-hostpanel${i === 0 ? ' is-active' : ''}" data-panel="${t.id}" data-group="${prefix}">
      ${t.kind === 'link' ? html`<a class="ah-btn ah-btn--lg ah-btn--block" href="${t.href}" rel="noopener">Open in ${t.name}</a>` : ''}
      ${t.kind === 'command' ? copyField(t.command) : ''}
      ${t.id === 'vscode' && t.command ? html`<p class="ah-small ah-muted" style="margin:10px 0 4px">Or from a terminal:</p>${copyField(t.command)}` : ''}
      ${t.kind === 'manual' ? html`<p class="ah-small ah-muted" style="margin:0 0 6px">Server URL</p>${copyField(url, 'Copy URL')}` : ''}
      <ol class="ah-steps-list">${t.steps.map((s) => html`<li>${s}</li>`)}</ol>
    </div>`,
  );
  return html`<div class="ah-hosts" role="group" aria-label="Agent app">${tiles}</div><div style="margin-top:16px">${panels}</div>`;
}

export const CHOOSER_SCRIPT = html`<script>
(function(){
  var KEY='ah_host';
  function pick(id){
    if(!document.querySelector('[data-host="'+id+'"]')) return;
    document.querySelectorAll('[data-host]').forEach(function(t){t.setAttribute('aria-pressed', t.getAttribute('data-host')===id?'true':'false');});
    document.querySelectorAll('[data-panel]').forEach(function(p){p.classList.toggle('is-active', p.getAttribute('data-panel')===id);});
    try{localStorage.setItem(KEY,id);}catch(e){}
  }
  document.addEventListener('click',function(e){var t=e.target.closest('[data-host]'); if(t) pick(t.getAttribute('data-host'));});
  var q=new URLSearchParams(location.search).get('app'); var saved=null; try{saved=localStorage.getItem(KEY);}catch(e){}
  pick(q||saved||'claude');
})();
</script>`;

// /add/<id> for someone whose agent isn't connected to the hub yet:
// connect once (and this tool comes along), or add only this tool.
export function installPage({ config, service, user, existing }) {
  const info = installInfo(config, service);
  const sum = summarizeTerms(info.terms);

  const body = html`
  <div class="ah-dialog">
    <div class="ah-ident">${serviceIcon(service)}<div><h1 style="font-size:1.6rem">${service.title}</h1>${verifiedPublisher(service, config)}</div></div>
    ${service.description ? html`<p class="ah-muted" style="margin:16px 0 0">${service.description}</p>` : ''}
    ${existing ? html`<div class="ah-note ah-note--good" style="margin-top:16px">You already have ${service.title}. <a href="/my">See it in My tools</a>.</div>` : ''}
    ${termsList(sum)}
    <div class="ah-note" style="margin:6px 0 16px"><b>Connect your agent to ${config.name} once.</b> ${service.title} comes along, and every other tool here is then one click away. Your agent can also find and try tools by itself.</div>
    <h3 style="margin-top:8px">Choose your agent app</h3>
    ${appChooser(info.hubTargets, info.hubUrl, 'hub')}
    <p class="ah-small ah-muted" style="margin-top:18px">Your app opens a sign-in page where you approve ${config.name} and ${service.title}. Manage everything in <a href="/my">My tools</a>.</p>
    <details class="ah-details" style="margin-top:6px">
      <summary>Or add only ${service.title}, as its own connector</summary>
      <div style="margin-top:12px">${appChooser(info.targets, info.mcpUrl, 'one')}</div>
    </details>
  </div>
  <div style="margin-top:16px">${behind(html`Your agent app adds <code>${info.hubUrl}</code> as one remote MCP server and signs in with OAuth 2.1 + PKCE. Every tool you add shows up inside that one connection, metered against its own plan. ${service.title}'s terms are in its <a href="${info.serverCard}">server card</a>.`)}</div>
  ${CHOOSER_SCRIPT}
  <script type="application/json" id="ah-install">${jsonForScript(info)}</script>`;
  return layout({ config, title: `Add ${service.title}`, body, user, narrow: true });
}
