// Keep/drop labels computed from usage. Simple rules; tune later.
// Shared by the gateway dashboard and the host library.

const DAY = 86400000;

export const LABELS = {
  'working-great': { text: 'Working great', tone: 'good', suggestion: 'upgrade' },
  'having-trouble': { text: 'Having trouble', tone: 'bad', suggestion: 'remove' },
  expensive: { text: 'Expensive', tone: 'warn', suggestion: 'review' },
  'just-added': { text: 'Just added', tone: 'neutral', suggestion: null },
  unused: { text: 'Unused', tone: 'warn', suggestion: 'remove' },
  'try-more': { text: 'Try more', tone: 'neutral', suggestion: null },
  'in-use': { text: 'In use', tone: 'good', suggestion: 'keep' },
};

// days: { 'YYYY-MM-DD': { calls, ok, latencyMs, costUsd } }
export function windowStats(days, now = Date.now(), windowDays = 7) {
  let calls = 0;
  let ok = 0;
  let latencyMs = 0;
  let costUsd = 0;
  const from = new Date(now - (windowDays - 1) * DAY).toISOString().slice(0, 10);
  for (const [day, b] of Object.entries(days || {})) {
    if (day < from) continue;
    calls += b.calls;
    ok += b.ok;
    latencyMs += b.latencyMs;
    costUsd += b.costUsd;
  }
  return {
    calls,
    ok,
    successRate: calls ? ok / calls : null,
    avgLatencyMs: calls ? Math.round(latencyMs / calls) : null,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
  };
}

export function totalStats(days) {
  return windowStats(days, Date.now(), 100000);
}

/**
 * @param {object} s
 * @param {number} s.calls7d
 * @param {number|null} s.successRate7d 0..1
 * @param {number} s.calls14d
 * @param {number} s.installedAt ms
 * @param {number|null} s.costPerOkUsd
 * @param {number} [s.expensiveAboveUsd=0.25]
 */
export function label(s, now = Date.now()) {
  const ageDays = (now - (s.installedAt || now)) / DAY;
  const expensiveAbove = s.expensiveAboveUsd ?? 0.25;
  let id;
  if (s.calls7d >= 5 && s.successRate7d !== null && s.successRate7d < 0.5) id = 'having-trouble';
  else if (s.costPerOkUsd !== null && s.costPerOkUsd !== undefined && s.costPerOkUsd > expensiveAbove) id = 'expensive';
  else if (s.calls7d >= 10 && s.successRate7d > 0.9) id = 'working-great';
  else if (s.calls14d === 0 && ageDays < 3) id = 'just-added';
  else if (s.calls14d === 0) id = 'unused';
  else if (s.calls7d < 3) id = 'try-more';
  else id = 'in-use';
  return { id, ...LABELS[id] };
}

export function labelFromDays(days, installedAt, now = Date.now(), opts = {}) {
  const w7 = windowStats(days, now, 7);
  const w14 = windowStats(days, now, 14);
  return label(
    {
      calls7d: w7.calls,
      successRate7d: w7.successRate,
      calls14d: w14.calls,
      installedAt,
      costPerOkUsd: w7.ok ? w7.costUsd / w7.ok : null,
      ...opts,
    },
    now,
  );
}
