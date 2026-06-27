import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

/**
 * kube-state-metrics CustomResourceStateMetrics manifest validity
 * (observability completion — GAP 2).
 *
 * The `KnextNextAppDegraded` alert reads `knext_nextapp_condition`, which only
 * exists if kube-state-metrics is told to emit it via a CustomResourceStateMetrics
 * config. #142 only documented that config in slos.md — it was never shipped as an
 * applyable manifest, so the alert was inert. This test asserts the manifest:
 *   1. is valid YAML and a Kubernetes ConfigMap,
 *   2. carries a CustomResourceStateMetrics config keyed off the NextApp CRD
 *      (group apps.kn-next.dev / version v1alpha1 / kind NextApp),
 *   3. reads the `status.conditions` path and emits `knext_nextapp_condition`.
 */

const MANIFEST_PATH = join(
  __dirname,
  '../../../../../../packages/kn-next-operator/config/observability/kube-state-metrics-crd-config.yaml',
);

const KUSTOMIZATION_PATH = join(
  __dirname,
  '../../../../../../packages/kn-next-operator/config/observability/kustomization.yaml',
);

function loadDocs(path: string) {
  const raw = readFileSync(path, 'utf8');
  const docs = parseAllDocuments(raw)
    .map((d) => d.toJS())
    .filter(Boolean);
  return { raw, docs };
}

describe('kube-state-metrics CustomResourceStateMetrics manifest (GAP 2)', () => {
  it('is valid YAML and a ConfigMap', () => {
    const { docs } = loadDocs(MANIFEST_PATH);
    const cm = docs.find((d) => d?.kind === 'ConfigMap');
    expect(cm, 'expected a ConfigMap in the manifest').toBeDefined();
    expect(cm.apiVersion).toBe('v1');
    expect(cm.metadata?.name).toBeTruthy();
    expect(cm.data, 'ConfigMap must carry the KSM config in data').toBeDefined();
  });

  it('embeds a CustomResourceStateMetrics config for the NextApp CRD', () => {
    const { docs } = loadDocs(MANIFEST_PATH);
    const cm = docs.find((d) => d?.kind === 'ConfigMap');
    const blob = Object.values(cm.data as Record<string, string>).join('\n');

    // The embedded config must be parseable YAML itself.
    const inner = parseAllDocuments(blob)
      .map((d) => d.toJS())
      .filter(Boolean);
    const crsm = inner.find((d) => d?.kind === 'CustomResourceStateMetrics');
    expect(crsm, 'embedded config must be a CustomResourceStateMetrics doc').toBeDefined();

    const resource = crsm.spec?.resources?.[0];
    expect(resource?.groupVersionKind?.group).toBe('apps.kn-next.dev');
    expect(resource?.groupVersionKind?.version).toBe('v1alpha1');
    expect(resource?.groupVersionKind?.kind).toBe('NextApp');
  });

  it('reads status.conditions and emits knext_nextapp_condition', () => {
    const { raw } = loadDocs(MANIFEST_PATH);
    // The emitted series name is metricNamePrefix + metric name.
    expect(raw).toContain('knext_nextapp');
    expect(raw).toMatch(/path:\s*\[?\s*status\s*,\s*conditions\s*\]?/);
    // Sanity: the Degraded/Ready condition type must be reachable as a label.
    expect(raw).toContain('conditions');
  });

  it('is wired into the observability kustomization (so the overlay applies it)', () => {
    const { raw } = loadDocs(KUSTOMIZATION_PATH);
    expect(raw).toContain('kube-state-metrics-crd-config.yaml');
  });

  it('lists condition status with metav1 capitalization (KSM matches case-sensitively)', () => {
    const { docs } = loadDocs(MANIFEST_PATH);
    const cm = docs.find((d) => d?.kind === 'ConfigMap');
    const blob = Object.values(cm.data as Record<string, string>).join('\n');
    const inner = parseAllDocuments(blob)
      .map((d) => d.toJS())
      .filter(Boolean);
    const crsm = inner.find((d) => d?.kind === 'CustomResourceStateMetrics');
    const stateSet = crsm.spec.resources[0].metrics[0].each.stateSet;
    // The reconciler writes metav1.Condition.Status as "True"/"False"/"Unknown"
    // (apimeta.SetStatusCondition). KSM StateSet matches the extracted value against
    // `list` case-sensitively, so lowercase entries would never match and
    // KnextNextAppDegraded{status="True"} would stay permanently at 0.
    expect(stateSet.list).toEqual(['True', 'False', 'Unknown']);
  });
});
