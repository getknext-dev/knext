import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

/**
 * PrometheusRule manifest validity (observability P0).
 *
 * The runbook + SLOs are only operable if the alert rules actually parse and
 * reference metric series that this codebase exports. This test asserts:
 *   1. the manifest is valid YAML and a well-formed PrometheusRule,
 *   2. every alert's `expr` is non-empty and references a real series,
 *   3. the four required SLO-breach alerts are present.
 *
 * (If `promtool` is installed in CI, `promtool check rules` is the stronger
 * gate — see the rule file header. This test is the always-available floor.)
 */

const RULE_PATH = join(
  __dirname,
  '../../../../../../packages/kn-next-operator/config/observability/prometheusrule.yaml',
);

// Series this repo actually exports (operator metrics.go + app registry.ts).
const KNOWN_SERIES = [
  'knext_nextapp_reconcile_total',
  'knext_nextapp_reconcile_duration_seconds',
  'knext_nextapp_reconcile_errors_total',
  'kn_next_http_requests_total',
  'kn_next_http_request_duration_seconds',
  'kn_next_startup_duration_seconds',
  'kn_next_bytecode_cache_warm_start',
  // kube-state-metrics series for the Degraded condition (documented dependency)
  'kube_customresource',
  'knext_nextapp_condition',
  // #348 deep-health state gauge (packages/kn-next/src/adapters/metrics.ts).
  'knext_deep_health_state',
];

interface Rule {
  alert?: string;
  expr?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

function loadRule() {
  const raw = readFileSync(RULE_PATH, 'utf8');
  const docs = parseAllDocuments(raw)
    .map((d) => d.toJS())
    .filter(Boolean);
  return { raw, docs };
}

describe('PrometheusRule manifest', () => {
  it('is valid YAML and a PrometheusRule kind', () => {
    const { docs } = loadRule();
    const rule = docs.find((d) => d?.kind === 'PrometheusRule');
    expect(rule).toBeDefined();
    expect(rule.apiVersion).toBe('monitoring.coreos.com/v1');
    expect(rule.spec?.groups?.length).toBeGreaterThan(0);
  });

  it('every alert has a name, a non-empty expr, severity, and runbook annotation', () => {
    const { docs } = loadRule();
    const rule = docs.find((d) => d?.kind === 'PrometheusRule');
    const alerts: Rule[] = rule.spec.groups.flatMap((g: { rules: Rule[] }) => g.rules);
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      expect(a.alert, JSON.stringify(a)).toBeTruthy();
      expect(typeof a.expr).toBe('string');
      expect((a.expr ?? '').trim().length).toBeGreaterThan(0);
      expect(a.labels?.severity).toMatch(/^(critical|warning)$/);
      expect(a.annotations?.runbook_url ?? a.annotations?.runbook).toBeTruthy();
      expect(a.annotations?.summary).toBeTruthy();
    }
  });

  it('every expr references at least one series this repo exports', () => {
    const { docs } = loadRule();
    const rule = docs.find((d) => d?.kind === 'PrometheusRule');
    const alerts: Rule[] = rule.spec.groups.flatMap((g: { rules: Rule[] }) => g.rules);
    for (const a of alerts) {
      const referencesKnown = KNOWN_SERIES.some((s) => (a.expr ?? '').includes(s));
      expect(referencesKnown, `expr has no known series: ${a.expr}`).toBe(true);
    }
  });

  it('wires the four required SLO-breach alerts', () => {
    const { docs } = loadRule();
    const rule = docs.find((d) => d?.kind === 'PrometheusRule');
    const names: string[] = rule.spec.groups
      .flatMap((g: { rules: Rule[] }) => g.rules)
      .map((r: Rule) => r.alert);

    // operator reconcileErrors > 0
    expect(names).toContain('KnextOperatorReconcileErrors');
    // NextApp Degraded=True
    expect(names).toContain('KnextNextAppDegraded');
    // cold-start p95 breach
    expect(names).toContain('KnextColdStartLatencyHigh');
    // cache/Redis unreachable
    expect(names).toContain('KnextCacheUnreachable');
  });

  // #348: a permanent connection-level DB outage sits at `waking` forever and
  // never becomes `down`, so alerting on `down`/503 alone never pages. The
  // sustained-waking alert closes that gap.
  it('#348 fires a SUSTAINED-waking alert on knext_deep_health_state with for: well above the wake budget', () => {
    const { docs } = loadRule();
    const rule = docs.find((d) => d?.kind === 'PrometheusRule');
    const alerts = rule.spec.groups.flatMap((g: { rules: (Rule & { for?: string })[] }) => g.rules);
    const stuck = alerts.find((a: Rule) => a.alert === 'KnextDeepHealthStuckWaking') as
      | (Rule & { for?: string })
      | undefined;

    expect(stuck, 'KnextDeepHealthStuckWaking alert must exist').toBeDefined();
    // Keys on the new deep-health state gauge, the waking slice specifically.
    expect(stuck?.expr).toContain('knext_deep_health_state');
    expect(stuck?.expr).toMatch(/state="waking"/);
    // `for:` must be well above the ~2-6s legitimate wake so a normal brief
    // wake NEVER pages, only a stuck-waking (real outage) does.
    expect(stuck?.for).toBeTruthy();
    const m = /^(\d+)m$/.exec(stuck?.for ?? '');
    expect(m, `for: must be minutes-scale, got ${stuck?.for}`).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(2);
    expect(stuck?.labels?.severity).toMatch(/^(critical|warning)$/);
    expect(stuck?.annotations?.runbook_url ?? stuck?.annotations?.runbook).toBeTruthy();
  });
});
