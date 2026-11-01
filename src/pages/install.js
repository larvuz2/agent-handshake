import { html, jsonForScript, raw } from '../util/html.js';
import { installTargets } from '../links.js';
import { summarizeTerms, termsExtension } from '../terms.js';
import { behind, copyField, layout, serviceIcon, verifiedPublisher } from './layout.js';
import { termsList } from './components.js';

export function installInfo(config, service) {
  const mcpUrl = `${config.publicUrl}/mcp/${service.id}`;
  const terms = termsExtension(service, config.publicUrl);
  return {
    service: { id: service.id, name: service.name, title: service.title, description: service.description, publisher: service.publisher },
    mcpUrl,
    serverCard: `${mcpUrl}/server-card`,
    terms,
    summary: summarizeTerms(terms).lines,
    targets: installTargets({ name: service.id, url: mcpUrl, title: service.title, description: service.description }),
  };
}

export function installPage({ config, service, user, existing }) {
  const info = installInfo(config, service);
  const sum = summarizeTerms(info.terms);

  const tiles = info.targets.map(
    (t, i) => html`<button type="button" class="ah-host" data-host="${t.id}" aria-pressed="${i === 0 ? 'true' : 'false'}"><b>${t.name}</b><span>${t.note || ' '}</span></button>`,
  );
  const panels = info.targets.map(
    (t, i) => html`<div class="ah-hostpanel${i === 0 ? ' is-active' : ''}" data-panel="${t.id}">
      ${t.kind === 'link' ? html`<a class="ah-btn ah-btn--lg ah-btn--block" href="${t.href}" rel="noopener">Open in ${t.name}</a>` : ''}
      ${t.kind === 'command' ? copyField(t.command) : ''}
      ${t.id === 'vscode' && t.command ? html`<p class="ah-small ah-muted" style="margin:10px 0 4px">Or from a terminal:</p>${copyField(t.command)}` : ''}
      ${t.kind === 'manual' ? html`<p class="ah-small ah-muted" style="margin:0 0 6px">Server URL</p>${copyField(info.mcpUrl, 'Copy URL')}` : ''}
      <ol class="ah-steps-list">${t.steps.map((s) => html`<li>${s}</li>`)}</ol>
    </div>`,
  );

  const body = html`
  <div class="ah-dialog">
    <div class="ah-ident">${serviceIcon(service)}<div><h1 style="font-size:1.6rem">${service.title}</h1>${verifiedPublisher(service, config)}</div></div>
    ${service.description ? html`<p class="ah-muted" style="margin:16px 0 0">${service.description}</p>` : ''}
    ${existing ? html`<div class="ah-note ah-note--good" style="margin-top:16px">You already have ${service.title}. <a href="/my">See it in My tools</a>.</div>` : ''}
    ${termsList(sum)}
    <h3 style="margin-top:8px">Choose your agent app</h3>
    <div class="ah-hosts" role="group" aria-label="Agent app">${tiles}</div>
    <div style="margin-top:16px">${panels}</div>
    <p class="ah-small ah-muted" style="margin-top:18px">Your app will open a sign-in page with the free-trial screen. You can remove ${service.title} anytime from <a href="/my">My tools</a>.</p>
  </div>
  <div style="margin-top:16px">${behind(html`Your agent app adds <code>${info.mcpUrl}</code> as a remote MCP server, discovers the sign-in from its <code>WWW-Authenticate</code> header, and gets a scoped trial token through OAuth 2.1 + PKCE. Terms are published in the <a href="${info.serverCard}">server card</a> under <code>_meta["dev.handshake/terms"]</code>.`)}</div>
  <script>
  (function(){
    var KEY='ah_host';
    function pick(id){
      var tiles=document.querySelectorAll('[data-host]'), panels=document.querySelectorAll('[data-panel]');
      if(!document.querySelector('[data-host="'+id+'"]')) return;
      tiles.forEach(function(t){t.setAttribute('aria-pressed', t.getAttribute('data-host')===id?'true':'false');});
      panels.forEach(function(p){p.classList.toggle('is-active', p.getAttribute('data-panel')===id);});
      try{localStorage.setItem(KEY,id);}catch(e){}
    }
    document.addEventListener('click',function(e){var t=e.target.closest('[data-host]'); if(t) pick(t.getAttribute('data-host'));});
    var q=new URLSearchParams(location.search).get('app'); var saved=null; try{saved=localStorage.getItem(KEY);}catch(e){}
    pick(q||saved||'claude');
  })();
  </script>
  <script type="application/json" id="ah-install">${jsonForScript(info)}</script>`;
  return layout({ config, title: `Add ${service.title}`, body, user, narrow: true, head: raw('') });
}
