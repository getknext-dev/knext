import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frozenFileSet } from '../scripts/compat-credential-freeze-guard.mjs';
import {
  DEFERRED_DERIVED,
  DEFERRED_FROZEN,
  DEFERRED_PINNED,
  findViolations,
  imageRefOk,
  MIRROR_ACTION,
  REPO_ROOT,
} from '../scripts/docker-hub-mirror-guard.mjs';

/**
 * #2106: anonymous Docker Hub pulls red docker-heavy jobs. Every job that pulls
 * must route through mirror.gcr.io (same digests, no secret) BEFORE its first
 * pulling step. This scans the real workflows, and fixtures prove the scanner
 * sees red.
 */

const fixtures: string[] = [];
afterEach(() => {
  for (const d of fixtures.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(workflow: string, scripts: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-mirror-'));
  fixtures.push(root);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'w.yml'), workflow);
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(root, name), body);
  return root;
}

const job = (steps: string, extra = '') => `name: w
on: push
jobs:
  j:
    runs-on: ubuntu-latest
${extra}    steps:
${steps}`;

describe('docker-hub-mirror-guard (fixtures)', () => {
  it('reds a job that docker-builds with no mirror step', () => {
    const root = fixture(job('      - run: docker build -t x .\n'));
    expect(findViolations(root).length).toBe(1);
  });

  it('greens when the mirror action precedes the pull', () => {
    const root = fixture(job(`      - uses: ${MIRROR_ACTION}\n      - run: docker build -t x .\n`));
    expect(findViolations(root)).toEqual([]);
  });

  it('reds when the mirror step comes AFTER the pull', () => {
    const root = fixture(job(`      - run: docker pull alpine\n      - uses: ${MIRROR_ACTION}\n`));
    expect(findViolations(root).length).toBe(1);
  });

  it('accepts the inline form (jobs that run before any checkout)', () => {
    const root = fixture(
      job(
        `      - run: |\n          echo '{"registry-mirrors":["https://mirror.gcr.io"]}' | sudo tee /etc/docker/daemon.json\n      - run: docker pull alpine\n`,
      ),
    );
    expect(findViolations(root)).toEqual([]);
  });

  it('reds setup-buildx / kind-action without the mirror', () => {
    expect(
      findViolations(fixture(job('      - uses: docker/setup-buildx-action@abc # v3\n'))).length,
    ).toBeGreaterThanOrEqual(1);
    expect(findViolations(fixture(job('      - uses: helm/kind-action@abc # v1\n'))).length).toBe(
      1,
    );
  });

  it('follows a run: script that itself pulls', () => {
    const root = fixture(job('      - run: bash scripts/x.sh\n'), {
      'scripts/x.sh': 'docker run --rm alpine true\n',
    });
    expect(findViolations(root).length).toBe(1);
  });

  it('reds an unprefixed Docker Hub services image, greens the mirror prefix', () => {
    const bad = fixture(
      job('      - run: echo hi\n', '    services:\n      r:\n        image: redis:7\n'),
    );
    expect(findViolations(bad).length).toBe(1);
    const ok = fixture(
      job(
        '      - run: echo hi\n',
        '    services:\n      r:\n        image: mirror.gcr.io/library/redis:7@sha256:aa\n',
      ),
    );
    expect(findViolations(ok)).toEqual([]);
  });

  it('imageRefOk: Docker Hub short refs fail; other registries and the mirror pass', () => {
    expect(imageRefOk('redis:7')).toBe(false);
    expect(imageRefOk('oven/bun:1')).toBe(false);
    expect(imageRefOk('mirror.gcr.io/library/redis:7')).toBe(true);
    expect(imageRefOk('ghcr.io/o/i:1')).toBe(true);
    expect(imageRefOk('us-central1-docker.pkg.dev/p/r/i@sha256:aa')).toBe(true);
  });

  it('reds setup-buildx-action with no buildkitd-config even when the mirror step runs', () => {
    const root = fixture(
      job(`      - uses: ${MIRROR_ACTION}\n      - uses: docker/setup-buildx-action@abc # v3\n`),
    );
    expect(findViolations(root).length).toBe(1);
    const ok = fixture(
      job(
        `      - uses: ${MIRROR_ACTION}\n      - uses: docker/setup-buildx-action@abc # v3\n        with:\n          buildkitd-config: /tmp/x.toml\n`,
      ),
    );
    expect(findViolations(ok)).toEqual([]);
  });

  it('skips deferred frozen files', () => {
    const root = fixture(job('      - run: docker build -t x .\n'));
    expect(findViolations(root, { deferred: ['.github/workflows/w.yml'] })).toEqual([]);
  });
});

describe('docker-hub-mirror-guard (the real workflows)', () => {
  it('no non-deferred workflow job pulls Docker Hub anonymously', () => {
    expect(findViolations(REPO_ROOT)).toEqual([]);
  });

  it('every deferral is still credential-frozen (a stale deferral must be removed)', () => {
    const frozen = frozenFileSet(REPO_ROOT);
    for (const f of DEFERRED_FROZEN) expect(frozen.has(f)).toBe(true);
  });

  // Deferral markers live HERE, not in the workflows: three of the four deferred files
  // are frozen or derived and cannot carry a comment without moving a fingerprint.
  // TODO(#2106): mirror test-e2e-deploy.yml + compat-vinext.yml (and re-derive
  // compat-credential-v1.3.yml) once the credential window closes; mirror
  // bun-base-build.yml under its own signing-chain review.
  it('the full deferred set equals the expected list (a new deferral needs a reason)', () => {
    expect([...DEFERRED_FROZEN, ...DEFERRED_DERIVED, ...DEFERRED_PINNED].sort()).toEqual([
      '.github/workflows/bun-base-build.yml',
      '.github/workflows/compat-credential-v1.3.yml',
      '.github/workflows/compat-vinext.yml',
      '.github/workflows/test-e2e-deploy.yml',
    ]);
  });

  it('every DEFERRED_DERIVED file is still a generated derived copy', () => {
    for (const f of DEFERRED_DERIVED) {
      const text = readFileSync(join(REPO_ROOT, f), 'utf8');
      expect(text).toContain('GENERATED by scripts/compat-line-workflow.mjs');
      expect(text).toMatch(/^# derived-from-sha256: [0-9a-f]{64}$/m);
    }
  });

  it('every DEFERRED_PINNED file still has its step order pinned by bun-base-supply-chain', () => {
    const pinTest = readFileSync(join(REPO_ROOT, 'tests/bun-base-supply-chain.test.ts'), 'utf8');
    for (const f of DEFERRED_PINNED) {
      const name = f.split('/').pop() ?? f;
      expect(pinTest).toContain(`${name}: the submit/download/verify/sign chain is pinned`);
      expect(pinTest).toContain('const REVIEWED_ORDER = [');
      expect(pinTest).toContain('const REVIEWED_RUN');
    }
  });

  it('the composite action sets the daemon mirror and a buildkitd mirror config', () => {
    const a = readFileSync(join(REPO_ROOT, '.github/actions/docker-hub-mirror/action.yml'), 'utf8');
    expect(a).toContain('registry-mirrors');
    expect(a).toContain('mirror.gcr.io');
    expect(a).toContain('buildkitd');
  });
});
