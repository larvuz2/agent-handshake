import { html } from '../util/html.js';
import { daysLeft } from '../entitlements.js';
import { labelFromDays, windowStats } from '../labels.js';
import { formatMoney, freePlan, planById, priceLabel, upgradePlans } from '../terms.js';
import { layout, mark, serviceIcon } from './layout.js';
import { csrfField, fmtDate, pill, planPill, timeAgo } from './components.js';

function toolCard({ e, service, store, grants, csrf }) {
  const plan = planById(service, e.planId);
  const days = store.usageDays(e.id);
  const w7 = windowStats(days, Date.now(), 7);
  const lab = labelFromDays(days, e.startedAt);
  const left = daysLeft(e);
  const apps = [...new Set(grants.map((g) => g.clientInfo?.title || g.clientInfo?.name || g.clientName || g.clientHost).filter(Boolean))];
  const ups = upgradePlans(service).filter((p) => p.id !== e.planId);
  const free = freePlan(service);
  const calls = e.limits.calls;
  const recent = store.recentCalls(e.id).slice(0, 8);

  let status;
  if (e.status === 'expired') status = pill(e.expiresAt ? `Ended ${fmtDate(e.expiresAt)}` : 'Ended', 'bad');
  else if (left !== null) status = pill(`${left} day${left === 1 ? '' : 's'} left`, left <= 2 ? 'warn' : 'neutral');

  return html`<article class="ah-card ah-tool" id="${e.id}">
    ${serviceIcon(service)}
    <div style="min-width:0">
      <div class="ah-row" style="gap:8px"><h3 style="margin:0">${service.title}</h3>${planPill(plan?.title || e.planId)}${e.status !== 'expired' ? pill(lab.text, lab.tone) : ''}${status || ''}</div>
      <div class="ah-tool-meta">
        <span>${calls !== undefined ? `${e.period.calls} of ${calls} calls${e.limits.period === 'day' ? ' today' : e.limits.period === 'month' ? ' this month' : ''}` : `${e.totals.calls} calls`}</span>
        <span>${w7.calls} in the last 7 days${w7.successRate !== null ? `, ${Math.round(w7.successRate * 100)}% ok` : ''}</span>
        ${e.totals.spendUsd > 0 ? html`<span>Spent ${formatMoney(e.totals.spendUsd)}</span>` : ''}
        ${e.lastUsedAt ? html`<span>Last used ${timeAgo(e.lastUsedAt)}</span>` : ''}
        ${apps.length ? html`<span>In ${apps.join(', ')}</span>` : ''}
      </div>
      ${calls ? html`<div class="ah-bar" title="Calls used"><i style="width:${Math.min(100, Math.round((e.period.calls / calls) * 100))}%"></i></div>` : ''}
      ${recent.length
        ? html`<details class="ah-details"><summary>Recent activity</summary><div class="ah-tablewrap"><table class="ah-table"><thead><tr><th>Tool</th><th>Result</th><th>Time</th><th>When</th></tr></thead><tbody>
          ${recent.map((c) => html`<tr><td><code>${c.tool}</code></td><td>${c.ok ? 'OK' : 'Failed'}</td><td>${c.latencyMs} ms</td><td>${timeAgo(c.at)}</td></tr>`)}
        </tbody></table></div></details>`
        : ''}
    </div>
    <div class="ah-tool-actions">
      ${ups.slice(0, 2).map((p) => html`<a class="ah-btn ah-btn--sm" href="/upgrade/${e.id}?plan=${p.id}">${p.x402 ? 'Pay per call' : `Upgrade ${priceLabel(p)}`}</a>`)}
      ${free && free.id !== e.planId ? html`<form method="post" action="/my/${e.id}/keep-free">${csrfField(csrf)}<button class="ah-btn ah-btn--sm ah-btn--ghost">Keep free</button></form>` : ''}
      <form method="post" action="/my/${e.id}/remove" data-msg="Remove ${service.title}? Your agent loses access right away." onsubmit="return confirm(this.dataset.msg)">${csrfField(csrf)}<button class="ah-btn ah-btn--sm ${lab.suggestion === 'remove' || e.status === 'expired' ? 'ah-btn--coral' : 'ah-btn--danger'}">Remove</button></form>
    </div>
  </article>`;
}

export function myPage({ config, user, entitlements, services, store, csrf, notice, hubGrants = [] }) {
  const active = entitlements.filter((e) => e.status !== 'dropped' && services.get(e.serviceId));
  const dropped = entitlements.filter((e) => e.status === 'dropped' && services.get(e.serviceId));
  const p = user?.spendPolicy || {};

  const body = html`
  <div class="ah-row" style="margin-bottom:8px"><h1 style="margin:0">My tools</h1><span class="ah-spacer"></span><a class="ah-btn ah-btn--ghost ah-btn--sm" href="/">Find tools</a></div>
  <p class="ah-muted">Everything your agent can use through this gateway. Keep what works, remove what doesn't.</p>
  ${user
    ? html`<div class="ah-card ah-card--flat ah-row" style="margin:16px 0;gap:14px">
        ${mark({ size: 34 })}
        <div style="flex:1;min-width:220px">${hubGrants.length
          ? html`<b>Your agent is connected</b><div class="ah-small ah-muted">In ${[...new Set(hubGrants.map((g) => g.clientInfo?.title || g.clientInfo?.name || g.clientName || g.clientHost))].join(', ')}. New tools show up there, no setup.</div>`
          : html`<b>Connect your agent once</b><div class="ah-small ah-muted">Then every tool is one click away, and your agent can find tools on its own.</div>`}</div>
        ${hubGrants.length
          ? html`<form method="post" action="/my/agent-settings" class="ah-row" style="gap:10px">${csrfField(csrf)}
              <label class="ah-check" style="margin:0"><input type="checkbox" name="auto" value="1" ${user.agentCanStartTrials !== false ? html`checked` : ''}> Let my agent start free trials</label>
              <button class="ah-btn ah-btn--sm ah-btn--ghost">Save</button></form>`
          : html`<a class="ah-btn ah-btn--sm" href="/connect">Connect</a>`}
      </div>`
    : ''}
  ${notice ? html`<div class="ah-note ah-note--${notice.tone || 'good'}" style="margin:16px 0">${notice.text}</div>` : ''}
  ${active.length === 0
    ? html`<div class="ah-card ah-card--soft ah-center" style="padding:40px 20px">${mark({ size: 48 })}<h3 style="margin-top:12px">No tools yet</h3><p class="ah-muted">Look for an <b>Add to my agent</b> button on a website, or browse the tools on this gateway.</p><a class="ah-btn" href="/#tools">Browse tools</a></div>`
    : active.map((e) =>
        toolCard({ e, service: services.get(e.serviceId), store, grants: store.find('grants', (g) => g.entitlementId === e.id && !g.revokedAt), csrf }),
      )}

  ${dropped.length
    ? html`<h3 style="margin-top:32px">Removed</h3>
      <div class="ah-card ah-card--flat">${dropped.map((e) => {
        const s = services.get(e.serviceId);
        return html`<div class="ah-row" style="padding:6px 0">${serviceIcon(s, true)}<b>${s.title}</b><span class="ah-muted ah-small">removed ${timeAgo(e.droppedAt)}</span><span class="ah-spacer"></span><a class="ah-btn ah-btn--sm ah-btn--ghost" href="/add/${s.id}">Add again</a></div>`;
      })}</div>`
    : ''}

  <h3 style="margin-top:32px">Spending limits</h3>
  <form class="ah-card ah-card--flat" method="post" action="/my/spend-policy">
    ${csrfField(csrf)}
    <p class="ah-small ah-muted" style="margin-top:0">These apply when your agent pays per call (x402), across every tool here. Subscriptions always need you to approve them on a checkout page.</p>
    <div class="ah-grid" style="grid-template-columns:repeat(auto-fill,minmax(min(100%,160px),1fr))">
      <div><label class="ah-label" for="pc">Per call (USD)</label><input class="ah-input" id="pc" name="perCallUsd" type="number" step="0.01" min="0" value="${p.perCallUsd ?? ''}"></div>
      <div><label class="ah-label" for="pd">Per day (USD)</label><input class="ah-input" id="pd" name="perDayUsd" type="number" step="0.01" min="0" value="${p.perDayUsd ?? ''}"></div>
      <div><label class="ah-label" for="pm">Per month (USD)</label><input class="ah-input" id="pm" name="perMonthUsd" type="number" step="0.01" min="0" value="${p.perMonthUsd ?? ''}"></div>
    </div>
    <div style="margin-top:14px"><button class="ah-btn ah-btn--sm">Save limits</button></div>
  </form>
  <p class="ah-small ah-muted" style="margin-top:24px">This list is tied to this browser. To open it somewhere else, ask your agent to run <code>handshake_status</code>: it returns a sign-in link.</p>`;
  return layout({ config, title: 'My tools', body, user });
}
