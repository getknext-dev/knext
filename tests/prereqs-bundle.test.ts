import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const INSTALL = 'scripts/prereqs/install.sh';
const bundle = read(INSTALL);
const knative = /^KNATIVE_VERSION="([^"]+)"/m.exec(bundle)?.[1];
const certManager = /^CERT_MANAGER_VERSION="([^"]+)"/m.exec(bundle)?.[1];

describe('prerequisite bundle pins', () => {
  it('declares both pins', () => {
    expect(knative).toMatch(/^knative-v\d+\.\d+\.\d+$/);
    expect(certManager).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('matches the versions the checksum-pinned helpers install', () => {
    expect(read('scripts/kind-manifests/apply-knative-kourier.sh')).toContain(
      `PINNED_KNATIVE_VERSION="${knative}"`,
    );
    expect(read('scripts/kind-manifests/apply-cert-manager.sh')).toContain(
      `CERT_MANAGER_VERSION="${certManager}"`,
    );
  });

  it('is the version the support matrix and install docs cite', () => {
    const matrix = read('apps/docs/content/docs/support-matrix.mdx');
    expect(matrix).toContain(`\`${knative}\``);
    expect(matrix).toContain(`\`${certManager}\``);
    const firstCluster = read('apps/docs/content/docs/first-cluster.mdx');
    expect(firstCluster).toContain('scripts/prereqs/install.sh');
    expect(read('apps/docs/content/docs/install.mdx')).toContain('scripts/prereqs/install.sh');
  });

  it('installs only through the checksum-verified helpers', () => {
    expect(bundle).toContain('"${HELPERS}/apply-cert-manager.sh"');
    expect(bundle).toContain('"${HELPERS}/apply-knative-kourier.sh" "${KNATIVE_VERSION}"');
    expect(bundle.replace(/^\s*#.*$/gm, '')).not.toMatch(/kubectl\s+apply/);
  });

  it('--print reports the pins', () => {
    const r = spawnSync('bash', [join(ROOT, INSTALL), '--print'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`knative=${knative} cert-manager=${certManager}`);
  });
});
