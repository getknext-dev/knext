import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

/**
 * Every namespaced object in scale-zero-pg's default apply path must name its
 * namespace.
 *
 * `kubectl apply -f packages/scale-zero-pg/deploy/` is the default install. An
 * object with no `metadata.namespace` lands in whatever namespace the current
 * context points at (usually `default`) instead of `scale-zero-pg`, leaving an
 * orphan the gateway cannot find: it then fails with `deployments.apps
 * "compute" not found`. The only objects allowed to omit it are cluster-scoped
 * kinds, which have no namespace at all.
 *
 * This SCANS the directory rather than enumerating files, and an unparseable
 * manifest FAILS rather than being skipped, so a new file cannot slip past.
 */
const DEPLOY = join(import.meta.dir, '..', 'packages', 'scale-zero-pg', 'deploy');
const MANIFEST = /\.(ya?ml|json)$/;

/** Kinds with no namespace. A kind NOT listed here is treated as namespaced. */
const CLUSTER_SCOPED = new Set([
  'Namespace',
  'ClusterRole',
  'ClusterRoleBinding',
  'CustomResourceDefinition',
  'StorageClass',
  'PersistentVolume',
  'PriorityClass',
  'IngressClass',
  'RuntimeClass',
  'CSIDriver',
  'APIService',
  'ValidatingWebhookConfiguration',
  'MutatingWebhookConfiguration',
  'ValidatingAdmissionPolicy',
  'ValidatingAdmissionPolicyBinding',
  'ClusterIssuer',
]);

interface Doc {
  kind?: string;
  items?: Doc[];
  metadata?: { name?: string; namespace?: string };
}

function manifests(): string[] {
  return readdirSync(DEPLOY, { withFileTypes: true })
    .filter((e) => e.isFile() && MANIFEST.test(e.name))
    .map((e) => e.name)
    .sort();
}

function docsOf(file: string): Doc[] {
  const out: Doc[] = [];
  for (const d of parseAllDocuments(readFileSync(join(DEPLOY, file), 'utf8'))) {
    if (d.errors.length > 0) {
      throw new Error(`${file}: unparseable manifest: ${d.errors[0].message}`);
    }
    const v = d.toJS() as Doc | null;
    if (!v) continue;
    out.push(v);
    if (Array.isArray(v.items)) out.push(...v.items);
  }
  return out;
}

function namespaceViolations(docs: Doc[], file: string): string[] {
  const bad: string[] = [];
  for (const doc of docs) {
    if (!doc.kind || doc.kind === 'List') continue;
    if (CLUSTER_SCOPED.has(doc.kind)) continue;
    if (!doc.metadata?.namespace) {
      bad.push(`${file}: ${doc.kind}/${doc.metadata?.name ?? '?'} has no metadata.namespace`);
    }
  }
  return bad;
}

describe('scale-zero-pg default apply path names a namespace on every namespaced object', () => {
  it('scans a non-trivial set of namespaced objects (guard is not vacuous)', () => {
    const namespaced = manifests().flatMap((f) =>
      docsOf(f).filter((d) => d.kind && d.kind !== 'List' && !CLUSTER_SCOPED.has(d.kind)),
    );
    expect(namespaced.length).toBeGreaterThan(40);
  });

  it('the compute Deployment is in a namespace (not left to land in default)', () => {
    const compute = docsOf('20-compute.yaml').find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === 'compute',
    );
    expect(compute?.metadata?.namespace).toBe('scale-zero-pg');
  });

  it('no namespaced object in deploy/* omits metadata.namespace', () => {
    const all = manifests().flatMap((f) => namespaceViolations(docsOf(f), f));
    expect(all).toEqual([]);
  });

  it('detects a namespace-less Deployment (negative control)', () => {
    const bad = namespaceViolations(
      [{ kind: 'Deployment', metadata: { name: 'compute' } }],
      'synthetic.yaml',
    );
    expect(bad).toHaveLength(1);
  });

  it('exempts cluster-scoped kinds (negative control)', () => {
    const ok = namespaceViolations(
      [
        { kind: 'ClusterRole', metadata: { name: 'x' } },
        { kind: 'Namespace', metadata: { name: 'x' } },
      ],
      'synthetic.yaml',
    );
    expect(ok).toEqual([]);
  });
});
