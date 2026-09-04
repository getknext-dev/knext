import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

/**
 * PrometheusRule manifest validity (observability P0).
 *
 * The runbook + SLOs are only operable if the alert rules actually parse and
 * carry the hygiene an on-call needs. This test asserts:
 *   1. the manifest is valid YAML and a well-formed PrometheusRule,
 *   2. every alert has a name, non-empty expr, severity and runbook link,
 *   3. the required SLO-breach and meta alerts are present.
 *
 * WHAT THIS TEST DELIBERATELY NO LONGER DOES, and why (#792). It used to assert
 * "every expr references at least one series this repo exports" against a
 * HAND-COPIED `KNOWN_SERIES` array. That array is why the drift survived: it
 * listed `kn_next_http_requests_total` because a human typed it, not because
 * anything emitted it, so the whole `knext.app` group could go dead while this
 * test stayed green. An enumerated list of names cannot detect a rename — it IS
 * the second copy that drifts.
 *
 * That assertion now lives in
 * `packages/kn-next/src/__tests__/observability-metric-contract.test.ts`, which
 * SCANS each emitter's own source (the runtime contract's exposition, the
 * operator's Go registry, the prom-client registries) instead of enumerating,
 * and covers the dashboards too. It is strictly stronger; this is a move, not a
 * relaxation.
 *
 * (If `promtool` is installed in CI, `promtool check rules` is the stronger
 * gate on SYNTAX — see the rule file header. This test is the always-available
 * floor.)
 */

const RULE_PATH = join(
  __dirname,
  '../../../../../../packages/kn-next-operator/config/observability/prometheusrule.yaml',
);

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

  it('wires the required SLO-breach alerts', () => {
    const { docs } = loadRule();
    const rule = docs.find((d) => d?.kind === 'PrometheusRule');
    const names: string[] = rule.spec.groups
      .flatMap((g: { rules: Rule[] }) => g.rules)
      .map((r: Rule) => r.alert);

    // operator reconcileErrors > 0
    expect(names).toContain('KnextOperatorReconcileErrors');
    // NextApp Degraded=True
    expect(names).toContain('KnextNextAppDegraded');
    // cold-start breach
    expect(names).toContain('KnextColdStartLatencyHigh');
    // server-side error ratio. This also subsumes the retired
    // `KnextCacheUnreachable`, which filtered on `route="/api/health"` — the
    // runtime emits no route label (unbounded cardinality; see the note in
    // runtime-contract.mjs), and a failing deep-health route returns 5xx, so it
    // lands here.
    expect(names).toContain('KnextHighErrorRate');
    // request latency — computable at all only since the runtime gained a
    // duration histogram (#792).
    expect(names).toContain('KnextHighRequestLatency');
  });

  // #792: the alerts that fire when the alerting itself has gone blind. A
  // renamed metric makes every rule above evaluate an empty vector — which is
  // indistinguishable from a healthy quiet system, and pages nobody. These two
  // are the only rules in the file that notice, so their presence is asserted
  // rather than assumed.
  it('ships the metrics-staleness meta-alerts', () => {
    const { docs } = loadRule();
    const rule = docs.find((d) => d?.kind === 'PrometheusRule');
    const alerts: Rule[] = rule.spec.groups.flatMap((g: { rules: Rule[] }) => g.rules);
    const names = alerts.map((r) => r.alert);

    expect(names).toContain('KnextAppMetricsTargetDown');
    expect(names).toContain('KnextAppMetricsContractBroken');

    // Neither may key on the app series alone: a scaled-to-zero app has no
    // pods and no series, so a bare absent() would fire nightly on every idle
    // app and be muted within a week. Both must anchor on `up`, which exists
    // only for a DISCOVERED target.
    for (const n of ['KnextAppMetricsTargetDown', 'KnextAppMetricsContractBroken']) {
      const a = alerts.find((r) => r.alert === n);
      expect(a?.expr, `${n} must anchor on up{...}`).toMatch(/\bup\{/);
    }
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

  // A failing image-prewarm reconcile used to return an error out of the
  // operator's Reconcile, so it incremented knext_nextapp_reconcile_errors_total
  // and fired the CRITICAL KnextOperatorReconcileErrors page. Decoupling it (so
  // an opt-in optimisation stops blocking app status convergence) removed that
  // page, and left only a condition nothing scrapes. Its own alert is what keeps
  // the failure visible — otherwise the decoupling trades a false-critical for a
  // silent failure.
  it('alerts on image-prewarm failures, at warning severity (the app is still healthy)', () => {
    const { docs } = loadRule();
    const rule = docs.find((d) => d?.kind === 'PrometheusRule');
    const alerts: (Rule & { for?: string })[] = rule.spec.groups.flatMap(
      (g: { rules: Rule[] }) => g.rules,
    );
    const prewarm = alerts.find((a) => a.alert === 'KnextImagePrewarmFailing');

    expect(prewarm, 'KnextImagePrewarmFailing alert must exist').toBeDefined();
    expect(prewarm?.expr).toContain('knext_nextapp_image_prewarm_errors_total');
    // Warning, NOT critical: the app serves fine, it just pays the image pull on
    // cold start. Paging at 3am for a latency optimisation is how alerts get muted.
    expect(prewarm?.labels?.severity).toBe('warning');
    expect(prewarm?.for).toBeTruthy();
    expect(prewarm?.annotations?.runbook_url ?? prewarm?.annotations?.runbook).toBeTruthy();
  });

  // The reconcile-error page must stay CRITICAL — the decoupling narrowed what
  // reaches it, and if that alert were softened too, nothing would page on a
  // genuinely failing control loop.
  it('keeps the reconcile-error alert at critical severity', () => {
    const { docs } = loadRule();
    const rule = docs.find((d) => d?.kind === 'PrometheusRule');
    const alerts: Rule[] = rule.spec.groups.flatMap((g: { rules: Rule[] }) => g.rules);
    const reconcile = alerts.find((a) => a.alert === 'KnextOperatorReconcileErrors');
    expect(reconcile?.labels?.severity).toBe('critical');
  });
});
