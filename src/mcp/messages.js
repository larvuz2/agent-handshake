// What the agent (and through it, the person) reads when a plan limit is hit,
// and what the built-in handshake_status tool says.

import { daysLeft } from '../entitlements.js';
import { labelFromDays, windowStats } from '../labels.js';
import { formatMoney, freePlan, planById, planThatUnlocks, priceLabel, upgradePlans } from '../terms.js';

export const STATUS_TOOL = 'handshake_status';

export function statusToolDefinition(service) {
  return {
    name: STATUS_TOOL,
    title: `${service.title}: plan and usage`,
    description:
      `Shows the person's Agent Handshake plan for ${service.title}: trial days left, calls used, ` +
      'and links to upgrade or remove the tool. Use it when they ask about their plan, or when a tool says a limit was reached.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function upgradeLines(ctx) {
  const { service, entitlement: e, links } = ctx;
  const lines = [];
  for (const p of upgradePlans(service)) {
    if (p.id === e.planId) continue;
    if (p.x402) lines.push(`- ${p.title} (${priceLabel(p)}): ${links.upgrade(p.id)}`);
    else lines.push(`- Upgrade to ${p.title} (${priceLabel(p)}): ${links.upgrade(p.id)}`);
  }
  const free = freePlan(service);
  if (free && free.id !== e.planId) lines.push(`- Switch to ${free.title} (free): ${links.upgrade(free.id)}`);
  return lines;
}

export function blockedMessage(reason, ctx, extra = {}) {
  const { service, entitlement: e, links } = ctx;
  const plan = planById(service, e.planId);
  const tail = () => {
    const ups = upgradeLines(ctx);
    return [
      ...(ups.length ? ['', 'Options (show these links to the person, they open in a browser):', ...ups] : []),
      `- Manage or remove: ${links.manage()}`,
    ].join('\n');
  };
  switch (reason) {
    case 'expired':
      return `${plan?.durationDays ? 'The free trial' : 'The plan'} for ${service.title} ended on ${fmtDate(e.expiresAt)}.\n${tail()}`;
    case 'calls': {
      const per = e.limits.period === 'day' ? ' today' : e.limits.period === 'month' ? ' this month' : '';
      return `All ${e.limits.calls} calls in the ${plan?.title || e.planId} plan for ${service.title} are used${per}.\n${tail()}`;
    }
    case 'scope': {
      const unlock = planThatUnlocks(service, extra.tool);
      return unlock
        ? `"${extra.tool}" is part of ${service.title} ${unlock.title} (${priceLabel(unlock)}), not the ${plan?.title || e.planId} plan.\n- Upgrade: ${links.upgrade(unlock.id)}\n- Manage: ${links.manage()}`
        : `"${extra.tool}" is not available on this plan.\n- Manage: ${links.manage()}`;
    }
    case 'spend':
      return (
        `This call costs ${formatMoney(extra.costUsd)}, which would go over the ${formatMoney(e.limits.spendUsd)} spend limit for ${service.title}.\n` +
        `- Change the limit or plan: ${links.manage()}`
      );
    case 'policy':
      return `This payment was blocked by the person's spending limits (${extra.detail}).\n- Change spending limits: ${links.manage()}`;
    case 'dropped':
      return `${service.title} was removed. Add it again from ${links.install()}`;
    default:
      return `${service.title} is not available right now.\n- Manage: ${links.manage()}`;
  }
}

export function statusText(ctx, store) {
  const { service, entitlement: e, links } = ctx;
  const plan = planById(service, e.planId);
  const days = store.usageDays(e.id);
  const w7 = windowStats(days, Date.now(), 7);
  const lab = labelFromDays(days, e.startedAt);
  const left = daysLeft(e);
  const lines = [`${service.title}: ${plan?.title || e.planId}`];
  if (e.status === 'expired') lines.push(`- Status: ended on ${fmtDate(e.expiresAt)}`);
  else if (left !== null) lines.push(`- ${left} day${left === 1 ? '' : 's'} left (ends ${fmtDate(e.expiresAt)})`);
  if (e.limits.calls !== undefined) lines.push(`- ${e.period.calls} of ${e.limits.calls} calls used`);
  else lines.push(`- ${e.totals.calls} calls so far`);
  if (e.totals.spendUsd > 0 || e.limits.spendUsd) {
    lines.push(`- Spent ${formatMoney(e.period.spendUsd)}${e.limits.spendUsd !== undefined ? ` of ${formatMoney(e.limits.spendUsd)} limit` : ''}`);
  }
  lines.push(`- Last 7 days: ${w7.calls} calls${w7.successRate !== null ? `, ${Math.round(w7.successRate * 100)}% succeeded` : ''}`);
  lines.push(`- Usage label: ${lab.text}`);
  const ups = upgradeLines(ctx);
  if (ups.length) lines.push('', 'Options (links open in a browser):', ...ups);
  lines.push(`- Manage or remove: ${links.manage()}`);
  return lines.join('\n');
}
