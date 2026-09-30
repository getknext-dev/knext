/**
 * The support-matrix page is a stranger's answer to "will this run on my
 * cluster?" Every version cited here must trace to a real file in the repo —
 * a CI workflow pin, a peer dependency range, or the operator's own
 * dependency versions — never an invented number. These assertions check
 * that the page's claims MATCH the source of truth, not just that the page
 * exists.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const PAGE = join(DOCS_DIR, 'support-matrix.mdx');
const page = readFileSync(PAGE, 'utf-8');

describe('docs — support matrix', () => {
  it('is listed in the sidebar navigation', () => {
    const meta = JSON.parse(readFileSync(join(DOCS_DIR, 'meta.json'), 'utf-8')) as {
      pages: string[];
    };
    expect(meta.pages).toContain('support-matrix');
  });

  it('has front matter with a title and description', () => {
    expect(page).toMatch(/^---\n(?:.*\n)*?title: .+\n(?:.*\n)*?description: .+\n---/);
  });

  it('states the Knative Serving version actually installed by the kind e2e gates', () => {
    const helper = readFileSync(
      resolve(REPO_ROOT, 'scripts/kind-manifests/apply-knative-kourier.sh'),
      'utf-8',
    );
    const pinned = helper.match(/PINNED_KNATIVE_VERSION="([^"]+)"/)?.[1];
    expect(pinned).toBeDefined();
    expect(page).toContain(pinned as string);
  });

  it('states the cert-manager version actually installed by the kind e2e gates', () => {
    const helper = readFileSync(
      resolve(REPO_ROOT, 'scripts/kind-manifests/apply-cert-manager.sh'),
      'utf-8',
    );
    const pinned = helper.match(/CERT_MANAGER_VERSION="([^"]+)"/)?.[1];
    expect(pinned).toBeDefined();
    expect(page).toContain(pinned as string);
  });

  it('states the Next.js version the compatibility credential window runs against', () => {
    const compatMatrix = readFileSync(join(DOCS_DIR, 'compat-matrix.mdx'), 'utf-8');
    const version = compatMatrix.match(/Next\.js v(\d+\.\d+\.\d+)/)?.[1];
    expect(version).toBeDefined();
    expect(page).toContain(version as string);
  });

  it('states the Next.js peer dependency floor from the published package', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/kn-next/package.json'), 'utf-8'),
    ) as { peerDependencies?: Record<string, string> };
    const floor = pkg.peerDependencies?.next;
    expect(floor).toBeDefined();
    expect(page).toContain(floor as string);
  });

  it('states the Node.js version CI runs against', () => {
    const ci = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8');
    const nodeVersion = ci.match(/node-version:\s*'?(\d+)'?/)?.[1];
    expect(nodeVersion).toBeDefined();
    expect(page).toContain(`Node.js ${nodeVersion}`);
  });

  it('states the Bun version CI pins', () => {
    const ci = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8');
    const bunVersion = ci.match(/bun-version:\s*'?(\d+\.\d+\.\d+)'?/)?.[1];
    expect(bunVersion).toBeDefined();
    expect(page).toContain(bunVersion as string);
  });

  it('states the minimum kubectl version required client-side for --validate=strict', () => {
    const doctor = readFileSync(resolve(REPO_ROOT, 'packages/kn-next/src/cli/doctor.ts'), 'utf-8');
    expect(doctor).toContain('v1.25');
    expect(page).toContain('1.25');
  });

  it('is honest that CI does not pin a specific Kubernetes minor version', () => {
    // scripts/kind-manifests carries no kubernetesVersion/node-image pin — the
    // page must not invent one either.
    expect(page).toMatch(/does not pin|no pinned|kind's default|not pinned/i);
  });

  it('names the clusters validated live, distinguishing reference from portable-by-design', () => {
    expect(page).toMatch(/GKE/);
    expect(page).toMatch(/OKE/);
    expect(page).toMatch(/EKS/);
  });

  it('contains no ADR references or issue/PR numbers (content-hygiene rules apply here too)', () => {
    expect(page).not.toMatch(/\bADR-?\s?\d/i);
    expect(page).not.toMatch(/(?:\bPR |\bissue |\(|\s)#\d+\b/i);
  });
});
