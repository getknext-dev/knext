import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P1.4 (ADR-0038) — the opt-in RBAC manifest must stay LEAST-PRIVILEGE.
 *
 * The Deployments page's high-fidelity source is the only part of the
 * observability recipe that can add a cluster trust surface, so the grant it
 * asks for is pinned here: namespaced, read-only, one resource family, and never
 * wired into the operator's default bundle.
 */

const APP_ROOT = resolve(import.meta.dirname, '../../../..');
const MANIFEST = resolve(APP_ROOT, 'deploy/observability-nextapp-read-rbac.yaml');

function manifest(): string {
  return readFileSync(MANIFEST, 'utf8');
}

describe('opt-in NextApp read RBAC', () => {
  it('is a namespaced Role — never a ClusterRole', () => {
    const src = manifest();
    expect(src).toMatch(/^kind: Role$/m);
    expect(src).not.toMatch(/kind: ClusterRole/);
    expect(src).not.toMatch(/kind: ClusterRoleBinding/);
  });

  it('grants read-only verbs on nextapps only', () => {
    const src = manifest();
    const rules = src.slice(src.indexOf('rules:'));
    expect(rules).toContain('apiGroups: ["apps.kn-next.dev"]');
    expect(rules).toContain('resources: ["nextapps", "nextapps/status"]');
    expect(rules).toContain('verbs: ["get", "list", "watch"]');
    for (const verb of ['create', 'update', 'patch', 'delete', 'deletecollection']) {
      expect(rules).not.toContain(verb);
    }
    // No wildcard escape hatch anywhere in the grant.
    expect(rules).not.toContain('"*"');
    // And no access to anything else the app has no business reading.
    for (const resource of ['secrets', 'configmaps', 'pods', 'services']) {
      expect(rules).not.toContain(resource);
    }
  });

  it('is marked opt-in and is NOT part of the operator install bundle', () => {
    expect(manifest()).toContain('knext.dev/opt-in: "true"');
    // Lives under the app's own deploy assets, not the operator config tree.
    expect(MANIFEST).toContain('/apps/file-manager/deploy/');
    expect(MANIFEST).not.toContain('kn-next-operator');
  });

  it('documents that enabling it also requires the explicit env opt-in', () => {
    expect(manifest()).toContain('OBSERVABILITY_NEXTAPP_SOURCE=kubernetes');
  });
});
