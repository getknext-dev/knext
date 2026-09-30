#!/usr/bin/env node
/**
 * error-budget — pure evaluation of the traffic-driver's request-error
 * budget for the operator upgrade-under-load e2e (#1668).
 *
 * The e2e drives light continuous HTTP traffic against a live NextApp for
 * the whole upgrade window (old operator -> new operator -> new CLI
 * redeploy) and logs one JSON line per attempt
 * (`{ts, ok, status}` — see traffic-monitor.mjs). This module turns that log
 * into a single pass/fail decision against a STATED budget, so the workflow
 * never eyeballs a request count.
 *
 * Kept as a pure function (no fs/process) so it is unit-testable without a
 * cluster — see tests/upgrade-e2e-error-budget.test.ts.
 */

/**
 * @param {{ok: boolean}[]} attempts - one entry per HTTP attempt made during
 *   the upgrade window, in the shape traffic-monitor.mjs logs.
 * @param {number} maxErrorRate - the stated error budget, e.g. 0.02 for 2%.
 * @returns {{ok: boolean, total: number, errors: number, rate: number}}
 */
export function evaluateErrorBudget(attempts, maxErrorRate) {
  if (!Array.isArray(attempts)) {
    throw new TypeError('attempts must be an array');
  }
  if (typeof maxErrorRate !== 'number' || maxErrorRate < 0 || maxErrorRate > 1) {
    throw new RangeError('maxErrorRate must be a number in [0, 1]');
  }
  const total = attempts.length;
  const errors = attempts.filter((a) => a.ok !== true).length;
  // No traffic at all is NOT a pass: a driver that never ran would otherwise
  // report a 0% error rate having proven nothing (the #659 "skip reports
  // green" failure mode, applied here).
  if (total === 0) {
    return { ok: false, total: 0, errors: 0, rate: 1 };
  }
  const rate = errors / total;
  return { ok: rate <= maxErrorRate, total, errors, rate };
}

/**
 * CLI entry: `node error-budget.mjs <attempts.jsonl> <maxErrorRate>`.
 * Reads one JSON object per line, evaluates, prints the result, and exits
 * non-zero on failure (including on a missing/empty log).
 */
async function main() {
  const { readFileSync } = await import('node:fs');
  const [, , logPath, maxErrorRateArg] = process.argv;
  if (!logPath || !maxErrorRateArg) {
    console.error('usage: error-budget.mjs <attempts.jsonl> <maxErrorRate>');
    process.exit(2);
  }
  const maxErrorRate = Number(maxErrorRateArg);
  let lines;
  try {
    lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
  } catch {
    lines = [];
  }
  const attempts = lines.map((l) => JSON.parse(l));
  const result = evaluateErrorBudget(attempts, maxErrorRate);
  console.log(JSON.stringify(result));
  if (!result.ok) {
    console.error(
      `error-budget FAILED: ${result.errors}/${result.total} requests failed ` +
        `(rate=${result.rate.toFixed(4)}, budget=${maxErrorRate})`,
    );
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
