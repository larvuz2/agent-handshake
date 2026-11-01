import { html } from '../util/html.js';
import { describeRedirect } from '../oauth/oauth.js';
import { planById, summarizeTerms, termsExtension } from '../terms.js';
import { daysLeft } from '../entitlements.js';
import { behind, icon, layout, mark, serviceIcon, verifiedPublisher } from './layout.js';
import { csrfField, fmtDate, termsList } from './components.js';

export function consentPage({ config, service, client, params, requestToken, csrf, existing, error }) {
  const redirect = describeRedirect(params.redirect_uri);
  const appName = client.client_name || redirect.host;
  const onlyLoopback = client.redirect_uris.every((u) => describeRedirect(u).kind === 'loopback');
  const terms = termsExtension(service, config.publicUrl);

  // Returning? Describe what they will get now, not the default trial.
  let planId;
  let returning = null;
  if (existing && existing.status !== 'dropped') {
    planId = existing.planId;
    returning = existing.status === 'expired' ? 'expired' : 'active';
  } else if (existing && existing.status === 'dropped') {
    const stillValid = !existing.expiresAt || existing.expiresAt > Date.now();
    planId = existing.planId;
    returning = stillValid ? 'resume' : 'expired';
  }
  const sum = summarizeTerms(terms, planId);
  const plan = planById(service, sum.plan.id);
  if (returning === 'resume' || returning === 'active') {
    const left = daysLeft(existing);
    if (left !== null) sum.duration = `${plan.title}: ${left} day${left === 1 ? '' : 's'} left`;
  }

  const primary =
    returning === 'expired'
      ? 'Connect'
      : returning
        ? 'Connect again'
        : plan.price === 0 && plan.durationDays
          ? 'Start free trial'
          : 'Connect';

  const body = html`
  <div class="ah-dialog">
    <div class="ah-row" style="gap:10px;margin-bottom:18px">
      <span class="ah-pill ah-pill--neutral" style="padding:6px 12px">${appName}</span>
      <span class="ah-muted">${icon('arrow', 16)}</span>
      ${mark({ size: 26 })}
      <span class="ah-muted">${icon('arrow', 16)}</span>
      <span class="ah-pill ah-pill--plan" style="padding:6px 12px">${service.title}</span>
    </div>
    <h1 style="font-size:1.45rem">${appName} wants to add ${service.title} to your agent</h1>
    <div class="ah-ident" style="margin-top:14px">${serviceIcon(service, true)}<div><b>${service.title}</b><br>${verifiedPublisher(service, config)}</div></div>
    ${error ? html`<div class="ah-note ah-note--bad" style="margin-top:16px">${error}</div>` : ''}
    ${returning === 'expired' ? html`<div class="ah-note ah-note--warn" style="margin-top:16px">${plan.durationDays ? 'Your free trial' : `Your ${plan.title} plan`} ended${existing.expiresAt ? html` on ${fmtDate(existing.expiresAt)}` : ''}. You can still connect; your agent will get a link to pick a plan.</div>` : ''}
    ${termsList(sum)}
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="request" value="${requestToken}">
      ${csrfField(csrf)}
      <div class="ah-row" style="flex-wrap:nowrap">
        <button class="ah-btn ah-btn--lg ah-btn--ghost" name="decision" value="deny" style="flex:1">Cancel</button>
        <button class="ah-btn ah-btn--lg" name="decision" value="allow" style="flex:2" autofocus>${primary}</button>
      </div>
    </form>
    <p class="ah-small ah-muted" style="margin:16px 0 0">
      Requested by <b>${redirect.host}</b>.${onlyLoopback ? ' Only continue if you started this yourself.' : ''}
      Remove it anytime in <a href="/my" target="_blank">My tools</a>.
    </p>
  </div>
  <div style="margin-top:16px">${behind(html`OAuth 2.1 + PKCE. The token works only for <code>${params.resource}</code>, only with the <b>${plan.title}</b> plan's permissions, and expires in an hour (your app refreshes it). No API keys are shared.`)}</div>`;
  return layout({ config, title: `Add ${service.title}`, body, narrow: true, nav: false });
}

// Connecting an agent to the hub (once). Optionally adds the tool the person came for.
export function hubConsentPage({ config, client, params, requestToken, csrf, pending, autoTrials = true }) {
  const redirect = describeRedirect(params.redirect_uri);
  const appName = client.client_name || redirect.host;
  const onlyLoopback = client.redirect_uris.every((u) => describeRedirect(u).kind === 'loopback');
  const pendingSum = pending ? summarizeTerms(termsExtension(pending, config.publicUrl)) : null;
  const body = html`
  <div class="ah-dialog">
    <div class="ah-row" style="gap:10px;margin-bottom:18px">
      <span class="ah-pill ah-pill--neutral" style="padding:6px 12px">${appName}</span>
      <span class="ah-muted">${icon('arrow', 16)}</span>
      ${mark({ size: 26 })}
      <span class="ah-pill ah-pill--plan" style="padding:6px 12px">${config.name}</span>
    </div>
    <h1 style="font-size:1.45rem">${appName} wants to connect to ${config.name}</h1>
    <ul class="ah-terms">
      <li><span class="ah-ti ah-ti--access">${icon('key', 17)}</span><div><b>Find, try and use tools for you</b><span>Every tool here, through this one connection</span></div></li>
      <li><span class="ah-ti ah-ti--time">${icon('clock', 17)}</span><div><b>Free trials start on their own</b><span>Each tool's trial terms are shown in My tools</span></div></li>
      <li><span class="ah-ti ah-ti--spend">${icon('wallet', 17)}</span><div><b>Spend limit: $0. Paid plans always need your OK.</b><span>Payment only ever happens on a checkout page</span></div></li>
    </ul>
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="request" value="${requestToken}">
      ${csrfField(csrf)}
      <label class="ah-check"><input type="hidden" name="auto" value="0"><input type="checkbox" name="auto" value="1" ${autoTrials ? html`checked` : ''}><span>Let my agent start free trials without asking me</span></label>
      ${pending ? html`<label class="ah-check"><input type="checkbox" name="also" value="${pending.id}" checked><span>Also add <b>${pending.title}</b> now (${pendingSum.duration})</span></label>` : ''}
      <div class="ah-row" style="flex-wrap:nowrap;margin-top:14px">
        <button class="ah-btn ah-btn--lg ah-btn--ghost" name="decision" value="deny" style="flex:1">Cancel</button>
        <button class="ah-btn ah-btn--lg" name="decision" value="allow" style="flex:2" autofocus>Connect</button>
      </div>
    </form>
    <p class="ah-small ah-muted" style="margin:16px 0 0">
      Requested by <b>${redirect.host}</b>.${onlyLoopback ? ' Only continue if you started this yourself.' : ''}
      Manage everything in <a href="/my" target="_blank">My tools</a>.
    </p>
  </div>
  <div style="margin-top:16px">${behind(html`OAuth 2.1 + PKCE. The token works only for <code>${params.resource}</code>. Each tool your agent adds gets its own plan and limits, checked on every call. No API keys are shared.`)}</div>`;
  return layout({ config, title: `Connect ${config.name}`, body, narrow: true, nav: false });
}
