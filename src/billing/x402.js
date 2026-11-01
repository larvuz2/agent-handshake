// Pay-per-call with x402 V2 over MCP (spec: x402 transports-v2/mcp.md).
//   1. Call without payment  -> tool result isError + PaymentRequired (structuredContent + text)
//   2. Client retries with params._meta["x402/payment"] = PaymentPayload
//   3. Gateway verifies with the facilitator, forwards the call, then settles
//   4. Success result carries _meta["x402/payment-response"]
// The person's spend policy (per call / day / month) is checked before anything is signed off.

import { windowStats } from '../labels.js';
import { formatMoney } from '../terms.js';

export const PAYMENT_META = 'x402/payment';
export const PAYMENT_RESPONSE_META = 'x402/payment-response';

// Known USDC deployments. Override with assetAddress / assetName / assetVersion in the plan.
const USDC = {
  'eip155:84532': { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2' }, // Base Sepolia (testnet)
  'eip155:8453': { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2' }, // Base
};

// "0.01" USD with 6 decimals -> "10000", without floating point.
export function toAtomic(amount, decimals = 6) {
  const [whole, frac = ''] = String(amount).split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0')).toString();
}

export class X402 {
  constructor({ config, store, users, log, fetchImpl }) {
    Object.assign(this, { config, store, users, log });
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  requirements(plan) {
    const x = plan.x402;
    const known = USDC[x.network] || {};
    return {
      scheme: 'exact',
      network: x.network,
      amount: toAtomic(x.pricePerCall, x.assetDecimals),
      asset: x.assetAddress || known.address,
      payTo: x.payTo,
      maxTimeoutSeconds: 60,
      extra: { name: x.assetName || known.name || x.asset, version: x.assetVersion || known.version || '2' },
    };
  }

  paymentRequired(ctx, plan, tool, error) {
    return {
      x402Version: 2,
      error,
      resource: {
        url: `mcp://tool/${tool}`,
        description: `${ctx.service.title}: ${tool} (${formatMoney(Number(plan.x402.pricePerCall))} per call)`,
        mimeType: 'application/json',
        serviceName: ctx.service.title,
      },
      accepts: [this.requirements(plan)],
    };
  }

  paymentRequiredResult(id, pr) {
    return { jsonrpc: '2.0', id, result: { isError: true, structuredContent: pr, content: [{ type: 'text', text: JSON.stringify(pr) }] } };
  }

  // The person's own limits, across every service on this gateway.
  checkPolicy(e, costUsd) {
    const user = this.store.get('users', e.userId);
    const p = user?.spendPolicy;
    if (!p) return { ok: true };
    if (p.perCallUsd !== undefined && costUsd > p.perCallUsd) {
      return { ok: false, detail: `${formatMoney(costUsd)} per call is above your ${formatMoney(p.perCallUsd)} per-call limit` };
    }
    const mine = this.store.find('entitlements', (x) => x.userId === e.userId);
    let day = 0;
    let month = 0;
    for (const x of mine) {
      const days = this.store.usageDays(x.id);
      day += windowStats(days, Date.now(), 1).costUsd;
      month += windowStats(days, Date.now(), 30).costUsd;
    }
    if (p.perDayUsd !== undefined && day + costUsd > p.perDayUsd) {
      return { ok: false, detail: `today's agent spending would pass your ${formatMoney(p.perDayUsd)} daily limit` };
    }
    if (p.perMonthUsd !== undefined && month + costUsd > p.perMonthUsd) {
      return { ok: false, detail: `this month's agent spending would pass your ${formatMoney(p.perMonthUsd)} monthly limit` };
    }
    return { ok: true };
  }

  async facilitator(path, body) {
    const res = await this.fetch(`${this.config.payments.x402.facilitatorUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !('isValid' in data) && !('success' in data)) throw new Error(`facilitator ${path} returned HTTP ${res.status}`);
    return data;
  }

  /**
   * Before forwarding a paid call.
   * @returns {{local: object}} to answer now, or {{payload, requirements, strip: true}} to continue
   */
  async requirePayment(ctx, msg, req, plan) {
    const tool = msg.params?.name;
    const payload = msg.params?._meta?.[PAYMENT_META];
    if (!payload) {
      return { local: this.paymentRequiredResult(msg.id, this.paymentRequired(ctx, plan, tool, 'Payment required to call this tool')) };
    }
    const requirements = this.requirements(plan);
    let v;
    try {
      v = await this.facilitator('/verify', { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
    } catch (err) {
      this.log?.warn?.(`x402 verify failed: ${err.message}`);
      return { local: this.paymentRequiredResult(msg.id, this.paymentRequired(ctx, plan, tool, 'Payment could not be verified right now')) };
    }
    if (!v.isValid) {
      return { local: this.paymentRequiredResult(msg.id, this.paymentRequired(ctx, plan, tool, `Payment invalid: ${v.invalidReason || 'unknown reason'}`)) };
    }
    return { payload, requirements, payer: v.payer };
  }

  // After the upstream answered successfully. Returns the message to send back.
  async settle(ctx, decision, msg) {
    const plan = ctx.service.plans.find((p) => p.id === ctx.entitlement.planId);
    const fail = (why) => this.paymentRequiredResult(msg.id, this.paymentRequired(ctx, plan, decision.tool, why));
    let s;
    try {
      s = await this.facilitator('/settle', {
        x402Version: 2,
        paymentPayload: decision.payment.payload,
        paymentRequirements: decision.payment.requirements,
      });
    } catch (err) {
      this.log?.warn?.(`x402 settle failed: ${err.message}`);
      return fail('Settlement failed');
    }
    if (!s.success) return fail(`Settlement failed: ${s.errorReason || 'unknown reason'}`);
    const meta = { ...(msg.result?._meta || {}), [PAYMENT_RESPONSE_META]: { success: true, transaction: s.transaction, network: s.network, payer: s.payer } };
    return { ...msg, result: { ...msg.result, _meta: meta } };
  }
}
