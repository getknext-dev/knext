import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * E2E for the operator release-integrity guard: executes the REAL steps of
 * `operator-supply-chain.yml` for an `operator-vX.Y.Z` tag, in a throwaway checkout, against a
 * locally assembled bundle. Nothing is re-typed: the guard step's `run:` body is extracted
 * from the workflow file and run with bash, with the env the workflow gives it, and the
 * version stamp is the real `hack/stamp-release-version.sh`.
 *
 * Simulated (no kustomize / registry offline): the `make build-installer` render. The bundle is
 * the real operator-v1.0.0 asset with its image line replaced by what kustomize would emit from
 * the stamped, re-pinned `newTag`. The digest re-pin is the workflow's own sed regex.
 *
 *   positive: stamp runs (as on any real release tag) => bundle pins vX.Y.Z => job step exits 0
 *   negative: stamp absent (the operator-v1.0.0 defect) => bundle pins v0.1.0 => job step FAILS
 */

const REPO = resolve(import.meta.dirname, '..');
const PKG = join(REPO, 'packages/kn-next-operator');
const WORKFLOW = readFileSync(join(REPO, '.github/workflows/operator-supply-chain.yml'), 'utf8');
const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures/operator-v1.0.0-install.yaml'),
  'utf8',
);
const BUILT = `sha256:${'c'.repeat(64)}`;
const IMG = 'ghcr.io/getknext-dev/kn-next-operator';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The `run: |` body of the named workflow step, de-indented. */
function stepRun(namePrefix: string): string {
  const at = WORKFLOW.indexOf(`- name: ${namePrefix}`);
  expect(at).toBeGreaterThan(-1);
  const next = WORKFLOW.indexOf('\n      - name:', at + 1);
  const block = WORKFLOW.slice(at, next === -1 ? undefined : next);
  const runAt = block.indexOf('        run: |\n');
  expect(runAt).toBeGreaterThan(-1);
  return block
    .slice(runAt + '        run: |\n'.length)
    .split('\n')
    .map((l) => l.replace(/^ {10}/, ''))
    .join('\n');
}

/** A throwaway "runner checkout": real scripts + a copy of the operator manager config. */
function runnerCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'op-release-e2e-'));
  dirs.push(root);
  symlinkSync(join(REPO, 'scripts'), join(root, 'scripts'));
  const pkg = join(root, 'packages/kn-next-operator');
  mkdirSync(join(pkg, 'config'), { recursive: true });
  cpSync(join(PKG, 'config/manager'), join(pkg, 'config/manager'), { recursive: true });
  mkdirSync(join(pkg, 'dist'));
  return root;
}

function assembleBundle(root: string, version: string, opts: { stamp: boolean }) {
  const pkg = join(root, 'packages/kn-next-operator');
  if (opts.stamp) {
    // the workflow's "Stamp the release version" step
    const r = spawnSync('bash', [join(PKG, 'hack/stamp-release-version.sh'), version, pkg], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  }
  // the workflow's digest re-pin (same regex as its `sed -E`)
  const kustPath = join(pkg, 'config/manager/kustomization.yaml');
  const kust = readFileSync(kustPath, 'utf8').replace(
    /(newTag: v[^@\s]+@sha256:)[0-9a-f]{64}/,
    `$1${BUILT.slice('sha256:'.length)}`,
  );
  writeFileSync(kustPath, kust);
  const newTag = /^\s*newTag: (v\S+)$/m.exec(kust)?.[1];
  expect(newTag).toBeTruthy();
  // stand-in for `kustomize build`: what it would render from that newTag
  const bundle = FIXTURE.replace(
    /^( *image: ).*kn-next-operator:v[^\s<]+@sha256:[0-9a-f]{64}$/m,
    `$1${IMG}:${newTag}`,
  );
  expect(bundle).not.toBe(FIXTURE);
  writeFileSync(join(pkg, 'dist/install.yaml'), bundle);
  writeFileSync(join(pkg, `dist/install-v${version}.yaml`), bundle);
}

function runGuardStep(root: string, version: string) {
  return spawnSync('bash', ['-c', stepRun('Verify the bundle pins this release')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DIGEST: BUILT,
      RELEASE_TAG: `operator-v${version}`,
      VERSIONED_ASSET: `packages/kn-next-operator/dist/install-v${version}.yaml`,
    },
  });
}

describe('operator release job (guard step), executed for real', () => {
  it('POSITIVE: a stamped release bundle passes the job step (exit 0)', () => {
    const root = runnerCheckout();
    assembleBundle(root, '1.4.0', { stamp: true });
    const r = runGuardStep(root, '1.4.0');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`pins operator-v1.4.0 image @ ${BUILT}`);
  });

  it('NEGATIVE: the unstamped bundle (operator-v1.0.0 defect) fails the job step', () => {
    const root = runnerCheckout();
    assembleBundle(root, '1.4.0', { stamp: false });
    expect(
      readFileSync(join(root, 'packages/kn-next-operator/dist/install.yaml'), 'utf8'),
    ).toContain(`${IMG}:v0.1.0@${BUILT}`);
    const r = runGuardStep(root, '1.4.0');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("bundle pins image tag 'v0.1.0'");
  });

  it('NEGATIVE: right tag but a digest from another build fails the job step', () => {
    const root = runnerCheckout();
    assembleBundle(root, '1.4.0', { stamp: true });
    const r = spawnSync('bash', ['-c', stepRun('Verify the bundle pins this release')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        DIGEST: `sha256:${'d'.repeat(64)}`,
        RELEASE_TAG: 'operator-v1.4.0',
        VERSIONED_ASSET: 'packages/kn-next-operator/dist/install-v1.4.0.yaml',
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('this run built');
  });
});
