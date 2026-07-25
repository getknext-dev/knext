import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

  it('grants ONLY `get`, by resource name, on nextapps', () => {
    const src = manifest();
    const rules = src.slice(src.indexOf('rules:'));
    expect(rules).toContain('apiGroups: ["apps.kn-next.dev"]');
    expect(rules).toContain('resources: ["nextapps", "nextapps/status"]');
    // The page reads exactly one object by name — list/watch would additionally
    // grant enumeration of every NextApp in the namespace, for no benefit.
    expect(rules).toContain('verbs: ["get"]');
    expect(rules).toMatch(/resourceNames: \[".+"\]/);
    for (const verb of ['list', 'watch', 'create', 'update', 'patch', 'delete']) {
      expect(rules).not.toContain(`"${verb}"`);
    }
    // No wildcard escape hatch anywhere in the grant.
    expect(rules).not.toContain('"*"');
    // And no access to anything else the app has no business reading.
    for (const resource of ['secrets', 'configmaps', 'pods', 'services']) {
      expect(rules).not.toContain(resource);
    }
  });

  it('is marked opt-in', () => {
    expect(manifest()).toContain('knext.dev/opt-in: "true"');
  });

  /**
   * The property this guards is "the operator's install bundle does not ship
   * this grant" — so it must read the OPERATOR TREE. (The previous version
   * asserted on the manifest's own path constant, which this test file built
   * itself: it could never fail, and in particular would not have caught the
   * file being added to a kustomization.)
   */
  it('is NOT referenced anywhere in the operator install bundle', () => {
    const operatorConfig = resolve(APP_ROOT, '../../packages/kn-next-operator/config');
    expect(existsSync(operatorConfig)).toBe(true);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ya?ml|json)$/.test(entry.name)) {
          continue;
        }
        const body = readFileSync(full, 'utf8');
        if (
          body.includes('observability-nextapp-read') ||
          body.includes('file-manager-observability')
        ) {
          offenders.push(full);
        }
      }
    };
    walk(operatorConfig);

    expect(offenders).toEqual([]);
  });

  it('the operator RBAC bundle grants nothing on nextapps to an APP ServiceAccount', () => {
    // Belt-and-braces on the same property from the other direction: the
    // operator's own role.yaml is the controller's grant, and the default
    // kustomization must not pull in an app-scoped nextapp read Role.
    const kustomization = readFileSync(
      resolve(APP_ROOT, '../../packages/kn-next-operator/config/rbac/kustomization.yaml'),
      'utf8',
    );
    expect(kustomization).not.toContain('observability');
    expect(kustomization).not.toContain('file-manager');
  });

  it('documents that enabling it also requires the explicit env opt-in', () => {
    expect(manifest()).toContain('OBSERVABILITY_NEXTAPP_SOURCE=kubernetes');
  });

  /**
   * Honesty guard (PR-520): the operator reconciles the app SA with
   * `automountServiceAccountToken: false`, so on a stock knext deploy no token
   * is projected and this Role changes nothing. The manifest must SAY so rather
   * than promise a two-step that cannot work.
   */
  it('discloses that an operator-managed deploy projects no ServiceAccount token', () => {
    const src = manifest();
    expect(src).toContain('automountServiceAccountToken: false');
    expect(src).toMatch(/not managed by the knext operator|NOT REACHABLE UNDER AN OPERATOR/i);
    expect(src).toContain('not-in-cluster');
    // …and must NOT still tell the reader to flip the pod-level knob.
    expect(src).not.toContain('must NOT set automountServiceAccountToken: false');
  });

  it('does not widen the process-wide TLS trust store', () => {
    expect(manifest()).not.toContain('NODE_EXTRA_CA_CERTS');
  });
});
