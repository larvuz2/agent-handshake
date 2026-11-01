import { html } from '../util/html.js';
import { formatMoney, freePlan, isFree, planById, priceLabel, scopeDescriptions, upgradePlans } from '../terms.js';
import { behind, layout, serviceIcon } from './layout.js';
import { csrfField, planPill } from './components.js';

export function upgradePage({ config, e, service, user, csrf, token, selected, mode }) {
  const current = planById(service, e.planId);
  const options = [...upgradePlans(service)];
  const free = freePlan(service);
  if (free) options.push(free);

  const cards = options.map((p) => {
    const isCurrent = p.id === e.planId && e.status !== 'expired';
    let action;
    if (isCurrent) action = html`<button class="ah-btn ah-btn--ghost ah-btn--block" disabled>Current plan</button>`;
    else if (isFree(p)) action = html`<button class="ah-btn ah-btn--ghost ah-btn--block" name="plan" value="${p.id}">Keep free</button>`;
    else if (p.x402) action = html`<button class="ah-btn ah-btn--block" name="plan" value="${p.id}">Use pay per call</button>`;
    else action = html`<button class="ah-btn ah-btn--block" name="plan" value="${p.id}">Continue to payment</button>`;
    return html`<div class="ah-card${p.id === selected ? '' : ' ah-card--flat'}" style="${p.id === selected ? 'border-color:var(--ah-blue)' : ''}">
      <h3 style="margin-bottom:4px">${p.title}</h3>
      <div style="font-size:1.6rem;font-weight:760;letter-spacing:-0.02em">${priceLabel(p)}</div>
      <ul class="ah-steps-list" style="margin:10px 0 16px">
        ${scopeDescriptions(service, p).map((d) => html`<li>${d}</li>`)}
        ${p.limits.calls !== undefined ? html`<li>Up to ${p.limits.calls} calls${p.limits.period === 'day' ? ' a day' : p.limits.period === 'month' ? ' a month' : ''}</li>` : html`<li>No call limit</li>`}
        ${p.x402 ? html`<li>Your agent pays ${formatMoney(Number(p.x402.pricePerCall))} per call in ${p.x402.asset}, within your spending limits</li>` : ''}
      </ul>
      ${action}
    </div>`;
  });

  const payNote =
    mode === 'stripe'
      ? 'Payment happens on Stripe Checkout. Your agent never sees card details.'
      : mode === 'external'
        ? `Payment happens on ${service.publisher.domain || 'the publisher'}'s checkout page.`
        : 'Test mode: the checkout is simulated and no money moves.';

  const body = html`
    <div class="ah-ident" style="margin-bottom:16px">${serviceIcon(service)}<div><h1 style="font-size:1.6rem">${service.title}</h1><span class="ah-muted">Current plan: ${planPill(current?.title || e.planId)}${e.status === 'expired' ? ' (ended)' : ''}</span></div></div>
    <form method="post" action="/upgrade/${e.id}">
      ${token ? html`<input type="hidden" name="t" value="${token}">` : csrfField(csrf)}
      <div class="ah-grid">${cards}</div>
    </form>
    <p class="ah-small ah-muted" style="margin-top:16px">${payNote}</p>
    ${behind(html`Upgrades use a page you open in your browser (MCP URL-mode elicitation), so payment details never pass through the agent. Pay-per-call uses <code>x402</code>: your agent signs a stablecoin payment for each call, and the gateway checks your spending limits first.`)}
    ${token ? '' : html`<p style="margin-top:16px"><a href="/my">Back to My tools</a></p>`}`;
  return layout({ config, title: `Upgrade ${service.title}`, body, user });
}

export function testCheckoutPage({ config, e, service, plan, ticket, user }) {
  const body = html`
  <div class="ah-dialog">
    <span class="ah-pill ah-pill--warn">Test mode</span>
    <h1 style="font-size:1.5rem;margin-top:12px">Checkout</h1>
    <div class="ah-ident" style="margin:16px 0">${serviceIcon(service, true)}<div><b>${service.title} ${plan.title}</b><br><span class="ah-muted">${priceLabel(plan)}</span></div></div>
    <p class="ah-muted">This gateway is in test mode, so this page stands in for a real checkout. No card, no charge.</p>
    <form method="post" action="/checkout/test">
      <input type="hidden" name="ticket" value="${ticket}">
      <button class="ah-btn ah-btn--lg ah-btn--block">Pay ${priceLabel(plan)} (simulated)</button>
    </form>
    <p class="ah-small ah-muted" style="margin:14px 0 0"><a href="/my">Cancel</a></p>
  </div>`;
  void e;
  return layout({ config, title: 'Test checkout', body, user, narrow: true });
}

export function x402ConfirmPage({ config, e, service, plan, user, csrf, token }) {
  const p = user?.spendPolicy || {};
  const body = html`
  <div class="ah-dialog">
    <h1 style="font-size:1.5rem">Let your agent pay per call?</h1>
    <div class="ah-ident" style="margin:16px 0">${serviceIcon(service, true)}<div><b>${service.title}: ${plan.title}</b><br><span class="ah-muted">${priceLabel(plan)} in ${plan.x402.asset} (${plan.x402.network})</span></div></div>
    <ul class="ah-steps-list">
      <li>Your agent's wallet pays each call with x402. This gateway never holds funds.</li>
      <li>Your limits: ${formatMoney(p.perCallUsd ?? 0)} per call, ${formatMoney(p.perDayUsd ?? 0)} a day, ${formatMoney(p.perMonthUsd ?? 0)} a month. Change them in My tools.</li>
    </ul>
    <form method="post" action="/upgrade/${e.id}" style="margin-top:16px">
      ${token ? html`<input type="hidden" name="t" value="${token}">` : csrfField(csrf)}<input type="hidden" name="confirm" value="1">
      <div class="ah-row" style="flex-wrap:nowrap"><a class="ah-btn ah-btn--ghost" href="/my" style="flex:1">Cancel</a><button class="ah-btn" name="plan" value="${plan.id}" style="flex:2">Turn on pay per call</button></div>
    </form>
  </div>`;
  return layout({ config, title: 'Pay per call', body, user, narrow: true });
}

export function donePage({ config, service, plan, user }) {
  const body = html`
  <div class="ah-dialog ah-center">
    <span class="ah-pill ah-pill--good">Done</span>
    <h1 style="font-size:1.5rem;margin-top:12px">${service.title} is on ${plan.title}</h1>
    <p class="ah-muted">Your agent can use it right away. Go back to your agent app and carry on.</p>
    <a class="ah-btn ah-btn--ghost" href="/my">Open My tools</a>
  </div>`;
  return layout({ config, title: 'Done', body, user, narrow: true });
}

export function loginConfirmPage({ config, token, tools, switching }) {
  const body = html`
  <div class="ah-dialog">
    <h1 style="font-size:1.5rem">Open My tools?</h1>
    <p class="ah-muted">This link opens the list of tools your agent connected${tools.length ? html`: <b>${tools.join(', ')}</b>` : ''}. From there you can upgrade, remove tools and set spending limits.</p>
    ${switching ? html`<div class="ah-note ah-note--warn" style="margin-bottom:14px">This browser already has a different list of tools. Continuing switches to the list from the link. Only continue if your own agent gave you this link.</div>` : ''}
    <form method="post" action="/my/login">
      <input type="hidden" name="t" value="${token}">
      <div class="ah-row" style="flex-wrap:nowrap"><a class="ah-btn ah-btn--ghost" href="/" style="flex:1">Cancel</a><button class="ah-btn" style="flex:2">Open My tools</button></div>
    </form>
  </div>`;
  return layout({ config, title: 'Open My tools', body, narrow: true });
}
