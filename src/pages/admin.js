import { html } from '../util/html.js';
import { windowStats } from '../labels.js';
import { formatMoney, planById } from '../terms.js';
import { copyField, layout, mark, serviceIcon } from './layout.js';
import { csrfField, fmtDate, pill, timeAgo } from './components.js';

export function adminLoginPage({ config, error }) {
  const body = html`<div class="ah-dialog">
    ${mark({ size: 40 })}
    <h1 style="font-size:1.5rem;margin-top:10px">Publisher dashboard</h1>
    <p class="ah-muted">Sign in with the admin key. It was printed when the gateway first started, and it is saved in <code>.handshake/secrets.json</code> (or set <code>HANDSHAKE_ADMIN_KEY</code>).</p>
    ${error ? html`<div class="ah-note ah-note--bad" style="margin-bottom:12px">${error}</div>` : ''}
    <form method="post" action="/admin/login">
      <label class="ah-label" for="k">Admin key</label>
      <input class="ah-input" id="k" name="key" type="password" autocomplete="current-password" required>
      <button class="ah-btn ah-btn--block" style="margin-top:14px">Sign in</button>
    </form>
  </div>`;
  return layout({ config, title: 'Publisher sign in', body, narrow: true });
}

function statusTone(s) {
  return { trial: 'neutral', active: 'good', expired: 'warn', dropped: 'bad' }[s] || 'neutral';
}

export function adminPage({ config, services, store, entitlements, csrf, notice }) {
  const sections = [...services.values()].map((s) => {
    const ents = entitlements.forService(s.id);
    let calls7 = 0;
    let ok7 = 0;
    for (const e of ents) {
      const w = windowStats(store.usageDays(e.id), Date.now(), 7);
      calls7 += w.calls;
      ok7 += w.ok;
    }
    const revenue = store.find('payments', (p) => p.serviceId === s.id).reduce((n, p) => n + (p.amount || 0), 0);
    const count = (st) => ents.filter((e) => e.status === st).length;
    const mcpUrl = `${config.publicUrl}/mcp/${s.id}`;
    const button = `<a href="${config.publicUrl}/add/${s.id}"><img src="${config.publicUrl}/badge/${s.id}.svg" alt="Add ${s.title} to my agent" height="44"></a>`;
    const rows = ents
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 100)
      .map((e) => {
        const plan = planById(s, e.planId);
        return html`<tr>
          <td><code>${e.userId.slice(0, 12)}</code></td>
          <td>${plan?.title || e.planId}</td>
          <td>${pill(e.status, statusTone(e.status))}</td>
          <td>${e.totals.calls}</td>
          <td>${e.expiresAt ? fmtDate(e.expiresAt) : '-'}</td>
          <td>${timeAgo(e.startedAt)}</td>
          <td><form method="post" action="/admin/entitlements/${e.id}" class="ah-row" style="gap:6px;flex-wrap:nowrap">${csrfField(csrf)}
            <button class="ah-btn ah-btn--sm ah-btn--ghost" name="action" value="extend7">+7 days</button>
            <select class="ah-select" name="plan" style="min-height:34px;padding:4px 8px;width:auto">${s.plans.map((p) => html`<option value="${p.id}">${p.title}</option>`)}</select>
            <button class="ah-btn ah-btn--sm ah-btn--ghost" name="action" value="grant">Set plan</button>
            ${e.status !== 'dropped' ? html`<button class="ah-btn ah-btn--sm ah-btn--danger" name="action" value="revoke">Revoke</button>` : ''}
          </form></td>
        </tr>`;
      });
    return html`<section class="ah-section">
      <div class="ah-ident">${serviceIcon(s)}<div><h2 style="margin:0">${s.title}</h2><span class="ah-muted ah-small">${s.name} · upstream ${new URL(s.upstream.url).host}</span></div></div>
      <div class="ah-stats" style="margin-top:20px">
        <div class="ah-stat"><b>${ents.length}</b><span>Installs</span></div>
        <div class="ah-stat"><b>${count('trial')}</b><span>On trial</span></div>
        <div class="ah-stat"><b>${count('active')}</b><span>Active plans</span></div>
        <div class="ah-stat"><b>${count('expired')}</b><span>Trial ended</span></div>
        <div class="ah-stat"><b>${count('dropped')}</b><span>Removed</span></div>
        <div class="ah-stat"><b>${calls7}</b><span>Calls, 7 days${calls7 ? ` (${Math.round((ok7 / calls7) * 100)}% ok)` : ''}</span></div>
        <div class="ah-stat"><b>${formatMoney(revenue)}</b><span>Payments recorded</span></div>
      </div>
      <h3 style="margin-top:24px">Share it</h3>
      <div class="ah-stack">
        <div><div class="ah-small ah-muted">Install page (the link behind your button)</div>${copyField(`${config.publicUrl}/add/${s.id}`)}</div>
        <div><div class="ah-small ah-muted">Button for your website or README</div>${copyField(button, 'Copy HTML')}</div>
        <div><div class="ah-small ah-muted">MCP server URL (for apps without install links)</div>${copyField(mcpUrl)}</div>
        <div class="ah-small ah-muted">Discovery: <a href="${mcpUrl}/server-card">server card</a> · <a href="/.well-known/ai-catalog.json">ai-catalog.json</a> · <a href="/llms.txt">llms.txt</a></div>
      </div>
      <h3 style="margin-top:24px">Installs</h3>
      ${ents.length
        ? html`<div class="ah-tablewrap"><table class="ah-table"><thead><tr><th>User</th><th>Plan</th><th>Status</th><th>Calls</th><th>Ends</th><th>Started</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : html`<p class="ah-muted">No installs yet. Share the install page above.</p>`}
    </section>`;
  });
  const body = html`
    <div class="ah-row"><h1 style="margin:0">Publisher dashboard</h1><span class="ah-spacer"></span>
      <span class="ah-pill ah-pill--neutral">Payments: ${config.payments.mode}</span>
      <form method="post" action="/admin/logout">${csrfField(csrf)}<button class="ah-btn ah-btn--sm ah-btn--ghost">Sign out</button></form></div>
    ${notice ? html`<div class="ah-note" style="margin-top:16px">${notice}</div>` : ''}
    ${sections}`;
  return layout({ config, title: 'Publisher dashboard', body });
}
