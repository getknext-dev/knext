/**
 * The warm-hold budget alert must exist, must be loadable, and must keep agreeing
 * with the knob it is derived from.
 *
 * WHY THIS EXISTS. `AppDatabase.spec.tier: warm` holds ONE authenticated apps-gateway
 * connection per warm app, permanently. `GW_MAX_CONNS` (deploy/81-apps-gateway.yaml) is
 * a PROCESS-WIDE semaphore shared with all tenant client traffic, so N warm apps put a
 * standing floor of N slots on a budget everyone else draws from — and exhaustion is
 * refused `53300` to OTHER apps' clients, fleet-wide. The capacity arithmetic was
 * documented; nothing paged before the wall, which by this repo's own standard is an
 * expectation that degrades unobserved until it has already failed (knext #787).
 *
 * The alert's threshold is a HAND-COPIED fraction of `GW_MAX_CONNS`. Prometheus cannot
 * read a Deployment's env, so the number lives in two files with nothing joining them —
 * the same drift shape this repo already guards for the load-soak SLOs. Raising
 * `GW_MAX_CONNS` without moving the alert makes it page early forever (and get silenced);
 * lowering it makes the alert fire only after the wall it exists to precede. So the join
 * is asserted here.
 *
 * WHAT THIS DOES NOT DO. It does not run Prometheus and needs no cluster: `_verify-alerting.sh`
 * is what proves rules actually load and route. This asserts the rule's identity, its
 * expression, its debounce, and that the two homes of the number still agree.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PROM = resolve(REPO_ROOT, 'packages/scale-zero-pg/deploy/60-prometheus.yaml');
const GATEWAY = resolve(REPO_ROOT, 'packages/scale-zero-pg/deploy/81-apps-gateway.yaml');

const promText = readFileSync(PROM, 'utf8');
const gatewayText = readFileSync(GATEWAY, 'utf8');

interface Rule {
  alert?: string;
  expr?: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
interface Group {
  name: string;
  rules?: Rule[];
}

/**
 * Parse the ConfigMap's `rules.yml` block, not the raw file text: a rule that is
 * syntactically present but nested under the wrong key never loads, and a text grep
 * would pass on it.
 */
function loadRules(): { groups: Group[]; rules: Rule[] } {
  const doc = promText.split(/^---$/m).find((d) => d.includes('rules.yml:')) ?? '';
  const cm = parse(doc);
  const rulesYml = cm?.data?.['rules.yml'];
  expect(typeof rulesYml, 'no rules.yml key in the prometheus ConfigMap').toBe('string');
  const groups: Group[] = parse(rulesYml).groups;
  return { groups, rules: groups.flatMap((g) => g.rules ?? []) };
}

const { groups, rules } = loadRules();
const alert = rules.find((r) => r.alert === 'WarmHoldBudgetPressure');

/** The deployed `GW_MAX_CONNS` value on the apps-gateway. */
function deployedMaxConns(): number {
  const m = gatewayText.match(/- name: GW_MAX_CONNS\s*\n\s*value: "(\d+)"/);
  expect(m, 'GW_MAX_CONNS not found in 81-apps-gateway.yaml').toBeTruthy();
  return Number(m?.[1]);
}

describe('warm-hold budget alert — it exists and can fire', () => {
  it('parses the rule file at all (not vacuous)', () => {
    expect(rules.length).toBeGreaterThan(20);
    expect(groups.map((g) => g.name)).toContain('ks-pg-gateway');
  });

  it('declares WarmHoldBudgetPressure as a warning in the gateway group', () => {
    expect(
      alert,
      'no WarmHoldBudgetPressure rule — warm-hold over-subscription is unobserved until ' +
        'it refuses 53300 to tenants who never opted into warmth (#787)',
    ).toBeTruthy();
    expect(alert?.labels?.severity).toBe('warning');
    const owner = groups.find((g) =>
      (g.rules ?? []).some((r) => r.alert === 'WarmHoldBudgetPressure'),
    );
    expect(owner?.name).toBe('ks-pg-gateway');
  });

  it('sums the warm-hold gauge across apps and compares it to half the connection budget', () => {
    const expr = alert?.expr ?? '';
    // The fleet-wide sum, not a per-app series: the budget is process-wide, so one
    // app's hold is never the thing that exhausts it.
    expect(expr).toMatch(/sum\(appdb_warm_hold_active\)/);
    expect(expr).toMatch(/0\.5\s*\*\s*\d+/);
    // No `or vector(0)`: the gauge is emitted ONLY for held apps, so with no warm apps
    // the series is absent, sum() is empty and the alert simply does not fire — which is
    // the correct behaviour, not a bug to patch around.
    expect(
      expr,
      'or vector(0) is wrong here — an empty sum means zero warm holds, which must not page',
    ).not.toMatch(/or\s+vector\(0\)/);
  });

  it('debounces for 15m so a reconcile blip cannot page', () => {
    expect(alert?.for).toBe('15m');
  });

  it('says what to do, and points at the runbook', () => {
    const text = `${alert?.annotations?.summary ?? ''} ${alert?.annotations?.description ?? ''}`;
    expect(text).toMatch(/tier: warm/);
    expect(text).toMatch(/operations\.md/);
  });
});

describe('warm-hold budget alert — the threshold and GW_MAX_CONNS cannot drift apart', () => {
  it('the alert threshold is exactly half the DEPLOYED GW_MAX_CONNS', () => {
    const maxConns = deployedMaxConns();
    const m = (alert?.expr ?? '').match(/0\.5\s*\*\s*(\d+)/);
    expect(m, 'no `0.5 * <GW_MAX_CONNS>` factor in the expr').toBeTruthy();
    expect(
      Number(m?.[1]),
      `the alert is written against GW_MAX_CONNS=${m?.[1]} but the apps-gateway deploys ` +
        `${maxConns} — the alert either pages early forever or only after the wall it precedes`,
    ).toBe(maxConns);
  });

  it('both files document the pairing, so the next editor of either sees the other', () => {
    expect(promText, 'the prometheus rule must name the file its threshold is copied from').toMatch(
      /81-apps-gateway\.yaml/,
    );
    expect(gatewayText, 'the GW_MAX_CONNS knob must name the alert derived from it').toMatch(
      /WarmHoldBudgetPressure/,
    );
  });
});
