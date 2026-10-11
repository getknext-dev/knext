import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { buildOperatorBody, parseInstallYaml } from '../scripts/operator-release-notes-body.mjs';

/**
 * TESTS for `scripts/operator-release-notes-body.mjs`: the generated body of the
 * `operator-vX.Y.Z` GitHub release (#2153).
 *
 * Everything the body states about the bundle (image digest, CRD API version, the
 * cert-manager requirement) is READ from the `install.yaml` the release attaches,
 * never typed, so the release notes cannot disagree with the asset beside them. The
 * fixture below mirrors the structure of a real published `install.yaml`
 * (kustomize output: list items at the key's indent, nested lists inside them).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/operator-release-notes-body.mjs');
const REPO = 'getknext-dev/knext';
const DIGEST = `sha256:${'3b35d33e'.repeat(8)}`;
const IMAGE = `ghcr.io/getknext-dev/kn-next-operator:v1.0.0@${DIGEST}`;

const CRD_DOC = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  annotations:
    controller-gen.kubebuilder.io/version: v0.20.1
  name: nextapps.apps.kn-next.dev
spec:
  group: apps.kn-next.dev
  names:
    kind: NextApp
  scope: Namespaced
  versions:
  - additionalPrinterColumns:
    - jsonPath: .status.revision
      name: Revision
      priority: 1
      type: string
    name: v1alpha1
    schema:
      openAPIV3Schema:
        properties:
          spec:
            properties:
              image:
                type: string
              storage:
                properties:
                  name:
                    type: string
    served: true
    storage: true
    subresources:
      status: {}
`;

const DEPLOYMENT_DOC = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: kn-next-operator-controller-manager
spec:
  template:
    spec:
      containers:
      - args:
        - --leader-elect
        image: ${IMAGE}
        name: manager
`;

const CERT_DOCS = `apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: kn-next-operator-serving-cert
spec:
  secretName: webhook-server-cert
---
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: kn-next-operator-selfsigned-issuer
spec:
  selfSigned: {}
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: kn-next-operator-validating-webhook-configuration
`;

function bundle(parts: { crd?: string; deployment?: string; cert?: string } = {}): string {
  const docs = [
    'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: kn-next-operator-system\n',
    parts.crd ?? CRD_DOC,
    'apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: kn-next-operator-controller-manager\n',
    parts.deployment ?? DEPLOYMENT_DOC,
    parts.cert ?? CERT_DOCS,
  ];
  return docs.join('---\n');
}

describe('the fixture is real YAML (so the parser is graded against a true bundle)', () => {
  it('every document parses and the Deployment image is where the fixture says', () => {
    const docs = bundle()
      .split(/^---$/m)
      .map((d) => parse(d) as Record<string, unknown>);
    expect(docs.map((d) => d.kind)).toContain('CustomResourceDefinition');
    const dep = docs.find((d) => d.kind === 'Deployment') as {
      spec: { template: { spec: { containers: Array<{ image: string }> } } };
    };
    expect(dep.spec.template.spec.containers[0].image).toBe(IMAGE);
  });
});

describe('parseInstallYaml', () => {
  it('reads the digest-pinned image, CRD name, group and version', () => {
    expect(parseInstallYaml(bundle())).toMatchObject({
      image: IMAGE,
      crdName: 'nextapps.apps.kn-next.dev',
      apiVersion: 'apps.kn-next.dev/v1alpha1',
      certManager: true,
      webhook: true,
    });
  });

  it('does not read a version-like `name:` from inside the schema', () => {
    // `spec.storage.properties.name` and the printer column name sit in the same
    // CRD document; only the version item's own `name:` counts.
    expect(parseInstallYaml(bundle()).apiVersion).toBe('apps.kn-next.dev/v1alpha1');
  });

  it('prefers the storage version when several are served', () => {
    const crd = CRD_DOC.replace(
      '  versions:\n',
      '  versions:\n  - name: v1alpha0\n    served: true\n    storage: false\n',
    );
    expect(parseInstallYaml(bundle({ crd })).apiVersion).toBe('apps.kn-next.dev/v1alpha1');
  });

  it('reports certManager=false when the bundle has no cert-manager Certificate', () => {
    const parsed = parseInstallYaml(
      bundle({ cert: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n' }),
    );
    expect(parsed.certManager).toBe(false);
    expect(parsed.webhook).toBe(false);
  });

  it('a cert-manager mention in a comment or annotation is not a Certificate', () => {
    const cert =
      'apiVersion: admissionregistration.k8s.io/v1\nkind: ValidatingWebhookConfiguration\nmetadata:\n  annotations:\n    cert-manager.io/inject-ca-from: ns/cert\n  name: w\n';
    expect(parseInstallYaml(bundle({ cert })).certManager).toBe(false);
  });

  it('refuses a bundle with no digest-pinned operator image', () => {
    const deployment = DEPLOYMENT_DOC.replace(`@${DIGEST}`, '');
    expect(() => parseInstallYaml(bundle({ deployment }))).toThrow(/digest/i);
  });

  it('refuses a bundle with two different operator images', () => {
    const deployment = `${DEPLOYMENT_DOC}      - image: ghcr.io/getknext-dev/kn-next-operator:v9@sha256:${'ab'.repeat(32)}\n        name: other\n`;
    expect(() => parseInstallYaml(bundle({ deployment }))).toThrow(/more than one|distinct/i);
  });

  it('refuses a bundle with no NextApp CRD', () => {
    expect(() => parseInstallYaml(bundle({ crd: 'apiVersion: v1\nkind: ConfigMap\n' }))).toThrow(
      /nextapps\.apps\.kn-next\.dev/,
    );
  });
});

describe('buildOperatorBody', () => {
  const info = parseInstallYaml(bundle());
  const body = buildOperatorBody({ tag: 'operator-v1.0.0', repo: REPO, info });

  it('states the install command for THIS tag', () => {
    expect(body).toContain(
      'kubectl apply -f https://github.com/getknext-dev/knext/releases/download/operator-v1.0.0/install.yaml',
    );
  });

  it('states the image digest read from install.yaml', () => {
    expect(body).toContain(IMAGE);
  });

  it('says cert-manager is required, because the bundle carries a Certificate', () => {
    expect(body).toMatch(/cert-manager must already be installed/);
  });

  it('omits the cert-manager requirement when the bundle has no Certificate', () => {
    const plain = buildOperatorBody({
      tag: 'operator-v1.0.0',
      repo: REPO,
      info: { ...info, certManager: false, webhook: false },
    });
    expect(plain).not.toMatch(/cert-manager/i);
  });

  it('states the CRD API version', () => {
    expect(body).toContain('CRD API version: `apps.kn-next.dev/v1alpha1`');
  });

  it('states the upgrade order: operator and CRD first, then the CLI', () => {
    expect(body).toContain('**Upgrade order:** upgrade the operator and CRD first, then the CLI.');
  });

  it('pairs the operator with the same major.minor of @getknext/core, for stable and rc tags', () => {
    expect(body).toContain('`@getknext/core` 1.0.x');
    const rc = buildOperatorBody({ tag: 'operator-v1.3.0-rc.2', repo: REPO, info });
    expect(rc).toContain('`@getknext/core` 1.3.x');
    expect(rc).toContain('/releases/download/operator-v1.3.0-rc.2/install.yaml');
  });

  it('links the compatibility matrix at the tag', () => {
    expect(body).toContain(
      'https://github.com/getknext-dev/knext/blob/operator-v1.0.0/docs/COMPATIBILITY.md',
    );
  });

  it('refuses a tag that is not operator-vX.Y.Z[-pre]', () => {
    for (const bad of ['operator-edge', 'operator-latest', 'v1.0.0', 'operator-v1.0', '../x']) {
      expect(() => buildOperatorBody({ tag: bad, repo: REPO, info })).toThrow(/operator-v/);
    }
  });
});

describe('CLI', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function setup(installText: string) {
    const dir = mkdtempSync(join(tmpdir(), 'operator-notes-'));
    dirs.push(dir);
    const install = join(dir, 'install.yaml');
    writeFileSync(install, installText);
    return { dir, install, out: join(dir, 'body.md') };
  }
  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
  }

  it('writes the body and a body_path output', () => {
    const { dir, install, out } = setup(bundle());
    const ghOut = join(dir, 'gh-output');
    const r = run(
      ['--tag', 'operator-v1.0.0', '--repo', REPO, '--install', install, '--out', out],
      {
        GITHUB_OUTPUT: ghOut,
      },
    );
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain(IMAGE);
    expect(readFileSync(ghOut, 'utf8')).toContain(`path=${out}\n`);
  });

  it('fails, writing no body, when install.yaml is missing', () => {
    const { dir, out } = setup(bundle());
    const r = run([
      '--tag',
      'operator-v1.0.0',
      '--repo',
      REPO,
      '--install',
      join(dir, 'nope.yaml'),
      '--out',
      out,
    ]);
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('fails, writing no body, when install.yaml has no pinned image', () => {
    const { install, out } = setup(
      bundle({ deployment: DEPLOYMENT_DOC.replace(`@${DIGEST}`, '') }),
    );
    const r = run(['--tag', 'operator-v1.0.0', '--repo', REPO, '--install', install, '--out', out]);
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('fails (usage) without --tag, --repo, --install or --out', () => {
    const { install, out } = setup(bundle());
    expect(run(['--repo', REPO, '--install', install, '--out', out]).status).not.toBe(0);
    expect(run(['--tag', 'operator-v1.0.0', '--install', install, '--out', out]).status).not.toBe(
      0,
    );
    expect(run(['--tag', 'operator-v1.0.0', '--repo', REPO, '--out', out]).status).not.toBe(0);
    expect(run(['--tag', 'operator-v1.0.0', '--repo', REPO, '--install', install]).status).not.toBe(
      0,
    );
  });
});

describe('operator-supply-chain.yml wiring', () => {
  const doc = parse(
    readFileSync(resolve(REPO_ROOT, '.github/workflows/operator-supply-chain.yml'), 'utf8'),
  ) as {
    jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
  };
  const steps = doc.jobs['operator-image-supply-chain'].steps;
  const bodyIdx = steps.findIndex((s) =>
    String(s.run ?? '').includes('operator-release-notes-body.mjs'),
  );
  const publishIdx = steps.findIndex((s) =>
    String(s.name ?? '').startsWith('Publish install.yaml to its channel release'),
  );

  it('generates the body from the attached install.yaml, for version tags only', () => {
    expect(bodyIdx).toBeGreaterThan(-1);
    const step = steps[bodyIdx];
    expect(String(step.run)).toContain('packages/kn-next-operator/dist/install.yaml');
    expect(String(step.if)).toContain("steps.channel.outputs.is_version_tag == 'true'");
    expect(String(step.if)).toContain("steps.trivy.outcome == 'success'");
  });

  it('builds the body before the release step and hands it over as body_path', () => {
    expect(publishIdx).toBeGreaterThan(bodyIdx);
    const withBlock = steps[publishIdx].with as Record<string, unknown>;
    expect(String(withBlock.body_path)).toBe(`\${{ steps.${steps[bodyIdx].id}.outputs.path }}`);
  });

  it('does not set a body on the mutable operator-latest release', () => {
    const latest = steps.find((s) => String(s.name ?? '').startsWith('Move operator-latest'));
    expect((latest?.with as Record<string, unknown>).body_path).toBeUndefined();
  });
});
