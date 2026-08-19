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

/**
 * The contiguous `#` comment block immediately above `- alert: WarmHoldBudgetPressure`.
 *
 * Scoped deliberately. Asserting rationale against the WHOLE file passes vacuously —
 * `kube_deployment_spec_replicas` is already used by `ComputeRoPoolStuck` further down,
 * so a file-wide match for it was green before the rejected-alternative note existed at
 * all. A guard satisfied by an unrelated rule is decoration.
 */
function ruleComment(): string {
  const lines = promText.split('\n');
  const at = lines.findIndex((l) => l.trim() === '- alert: WarmHoldBudgetPressure');
  expect(at, 'the alert rule was not found in 60-prometheus.yaml').toBeGreaterThan(-1);
  const block: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i].trim().startsWith('#'); i--) block.unshift(lines[i]);
  return block.join('\n');
}

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

  // The three assertions below guard PROSE, which is unusual — justified because the
  // annotation is the whole artifact at 3am, and its first version got the arithmetic
  // wrong by the replica factor (code review #791, issue 1). A wrong number on a page is
  // worse than no page: it is what the responder uses to judge urgency.
  it('frames the threshold PER POD, and names the fleet arithmetic', () => {
    const text = `${alert?.annotations?.summary ?? ''} ${alert?.annotations?.description ?? ''}`;
    // 90 is ONE pod's semaphore; pggw-apps runs 2 replicas, and holds load-balance
    // across them, so the fleet budget is replicas x 90 and 45 holds is ~25% of it.
    expect(text, 'the annotation must say the budget it compares against is per pod').toMatch(
      /per pod|single gateway pod/,
    );
    expect(
      text,
      'the annotation must give the fleet arithmetic, not just the per-pod number',
    ).toMatch(/replicas\s*(x|×|\*)\s*90/);
    // The exact claim that was wrong on the first round. Asserting its ABSENCE is what
    // stops it being reinstated by someone tightening the wording.
    expect(
      text,
      "false: 90 is one pod's budget, so 45 holds is not half the apps-gateway's budget",
    ).not.toMatch(/half (of )?the apps-gateway/i);
  });

  it('attributes the gauge to DECLARED holds — tier: warm AND warmSchedule windows', () => {
    // The exporter counts both forms (knext #388). An annotation naming only tier: warm
    // sends a responder paged during a large scheduled window hunting for holders that
    // the tier column does not list.
    const description = alert?.annotations?.description ?? '';
    expect(description).toMatch(/warmSchedule/);
  });

  it('records the rejected replica-join alternative so it is not re-proposed', () => {
    // Making the expr replica-aware means joining kube-state-metrics; scalar() over an
    // absent ksm series makes the whole alert silently unable to fire — the blindness
    // class #792 documents. The expr stays static and conservative; the comment must
    // carry the reasoning, or the "obvious improvement" gets re-suggested every review.
    const comment = ruleComment();
    expect(
      comment,
      "this rule's own comment must name the rejected kube_deployment_spec_replicas join and why",
    ).toMatch(/kube_deployment_spec_replicas/);
    expect(comment, 'and the reason: an absent ksm series would silence the alert').toMatch(
      /scalar/,
    );
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
    // Scoped to this rule's comment, not the file: a mention anywhere in a 700-line
    // manifest would not tell the next editor of THIS threshold where the knob lives.
    expect(
      ruleComment(),
      'the prometheus rule must name the file its threshold is copied from',
    ).toMatch(/81-apps-gateway\.yaml/);
    expect(gatewayText, 'the GW_MAX_CONNS knob must name the alert derived from it').toMatch(
      /WarmHoldBudgetPressure/,
    );
  });
});
