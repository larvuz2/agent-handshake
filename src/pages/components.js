import { html } from '../util/html.js';
import { icon } from './layout.js';

// The three consent lines: what it can access, for how long, spend limit.
export function termsList(summary, { accessTitle = 'Can access' } = {}) {
  return html`<ul class="ah-terms">
    <li><span class="ah-ti ah-ti--access">${icon('key', 17)}</span><div><b>${summary.access.join(' · ')}</b><span>${accessTitle}</span></div></li>
    <li><span class="ah-ti ah-ti--time">${icon('clock', 17)}</span><div><b>${summary.duration}</b><span>Plan: ${summary.plan.title}</span></div></li>
    <li><span class="ah-ti ah-ti--spend">${icon('wallet', 17)}</span><div><b>${summary.spend}</b><span>${summary.plan.price === 0 && !summary.plan.x402 ? (summary.plan.durationDays ? 'Nothing is charged during the trial' : 'This plan is free') : 'You stay in control of payments'}</span></div></li>
  </ul>`;
}

export function pill(text, tone = 'neutral') {
  return html`<span class="ah-pill ah-pill--${tone}">${text}</span>`;
}

export function planPill(text) {
  return html`<span class="ah-pill ah-pill--plan">${text}</span>`;
}

export function csrfField(token) {
  return html`<input type="hidden" name="csrf" value="${token}">`;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
