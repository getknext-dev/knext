import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * GUARD TESTS for the in-process Rust e2e lane (.github/workflows/ffi-e2e.yml).
 *
 * 1. **Path filters cover what the lane consumes — scanned, not enumerated.**
 *    The lane is path-filtered and not a required check, so a filter that
 *    misses a file the lane reads means a regression in that file lands with
 *    the lane never run. Every repo path the workflow's `run:` blocks name,
 *    and every repo path the lane's own scripts (packages/ffi/scripts/) name
 *    or import, must be matched by BOTH `paths:` lists — and the two lists
 *    must be the same list.
 * 2. **compat-smoke gates on the SHIPPED image.** The gate step runs the
 *    runner against the digest-pinned image `knext deploy` pushed (the
 *    NextApp's spec.image), not only a host-arch twin; it is conditioned on
 *    `!cancelled()`, never `always()` (which would run it on a cancelled run).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/ffi-e2e.yml');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'packages/ffi/scripts');

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
}
interface Workflow {
  on: { pull_request: { paths: string[] }; push: { paths: string[] } };
  jobs: Record<string, { steps: Step[] }>;
}

const wf = parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;

/** GitHub's path-filter glob: `**` crosses `/`, `*` does not. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** GitHub semantics: the LAST pattern that matches decides (a `!` pattern excludes). */
function filtered(paths: string[], file: string): boolean {
  let hit = false;
  for (const p of paths) {
    const negated = p.startsWith('!');
    if (globToRegExp(negated ? p.slice(1) : p).test(file)) hit = !negated;
  }
  return hit;
}

const REPO_PATH =
  /(?:^|[\s"'(=:])((?:apps|packages|scripts|crates|\.github)\/[A-Za-z0-9._\-/]*[A-Za-z0-9_-])/g;

/** Repo-relative paths named literally in a text. */
function namedPaths(text: string): string[] {
  return [...text.matchAll(REPO_PATH)].map((m) => m[1] as string);
}

/** Repo-relative targets of relative imports in a script. */
function relativeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/from '(\.\.?\/[^']+)'/g)) {
    out.push(relative(REPO_ROOT, resolve(dirname(file), m[1] as string)));
  }
  return out;
}

describe('ffi-e2e.yml path filters', () => {
  const pr = wf.on.pull_request.paths;
  const push = wf.on.push.paths;

  it('pull_request and push filter the same list', () => {
    expect(push).toEqual(pr);
  });

  it('names the inputs the lane consumes (the review list, targeted half)', () => {
    for (const must of [
      'apps/file-manager/**',
      'packages/kn-next-operator/**',
      'scripts/kind-manifests/**',
      'scripts/pack-release-tarballs.mjs',
      'packages/kn-next/**',
      'packages/lib/**',
      'packages/db/**',
      'bun.lock',
      '.github/actions/docker-hub-mirror/**',
    ]) {
      expect(pr).toContain(must);
    }
  });

  it('matches every repo path the workflow run blocks and the lane scripts read (scanned half)', () => {
    // Every step field, not only `run:` (`working-directory:`, `with:` inputs
    // such as `go-version-file:` name repo paths too).
    const runText = Object.values(wf.jobs)
      .flatMap((j) => j.steps)
      .map((s) =>
        Object.values(s)
          .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
          .join('\n'),
      )
      .join('\n');
    const scripts = readdirSync(SCRIPTS_DIR).map((f) => resolve(SCRIPTS_DIR, f));
    const candidates = new Set<string>([
      ...namedPaths(runText),
      ...scripts.flatMap((f) => [...namedPaths(readFileSync(f, 'utf8')), ...relativeImports(f)]),
    ]);
    // Only paths that exist (or whose directory exists): prose such as
    // `packages/ffi/src/build.ts` in a comment is still a real file and counts.
    const real = [...candidates].filter(
      (p) => existsSync(resolve(REPO_ROOT, p)) || existsSync(resolve(REPO_ROOT, `${p}.ts`)),
    );
    expect(real.length).toBeGreaterThan(10);
    // A directory is consumed whole: a file inside it must be filtered.
    const asFile = (p: string) =>
      existsSync(resolve(REPO_ROOT, p)) && statSync(resolve(REPO_ROOT, p)).isDirectory()
        ? `${p}/x`
        : p;
    const unfiltered = real.filter((p) => !filtered(pr, asFile(p)) && !filtered(pr, `${p}.ts`));
    expect(unfiltered).toEqual([]);
  });

  it('the matcher itself sees an unfiltered path (the scan can go red)', () => {
    expect(filtered(pr, 'apps/docs/content/docs/index.mdx')).toBe(false);
    expect(
      filtered(
        ['packages/kn-next/**', '!packages/kn-next/src/__tests__/**'],
        'packages/kn-next/src/__tests__/x.test.ts',
      ),
    ).toBe(false);
    expect(filtered(['packages/kn-next/**'], 'packages/kn-next/src/cli/deploy.ts')).toBe(true);
  });
});

describe('ffi-e2e.yml compat-smoke gates on the shipped image', () => {
  const steps = wf.jobs['kind-e2e']?.steps ?? [];
  const idx = (pred: (s: Step) => boolean) => steps.findIndex(pred);
  const smoke = steps.find((s) => s.id === 'smoke');
  const shipped = steps.find((s) => s.id === 'shipped');

  it('resolves the digest-pinned image the deploy pushed, from the NextApp, after the deploy', () => {
    expect(shipped).toBeDefined();
    const deploy = idx((s) => (s.run ?? '').includes('deploy --skip-build'));
    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(idx((s) => s.id === 'shipped')).toBeGreaterThan(deploy);
    expect(shipped?.run).toContain('{.spec.image}');
    expect(shipped?.run).toContain('@sha256:');
    expect(shipped?.run).toContain('SHIPPED_IMAGE=');
  });

  it('runs the runner against that image, on !cancelled(), never always()', () => {
    expect(smoke).toBeDefined();
    expect(smoke?.run).toContain('run-compat-smoke-image.sh');
    expect(smoke?.run).toContain('SHIPPED_IMAGE');
    expect(smoke?.if).toContain('!cancelled()');
    expect(smoke?.if).toContain("steps.shipped.outcome == 'success'");
    expect(smoke?.if ?? '').not.toContain('always()');
  });

  it('keeps the host-arch twin as attribution only (never the gate)', () => {
    const twin = steps.filter((s) => (s.run ?? '').includes('run-compat-smoke.sh '));
    expect(twin.length).toBeGreaterThan(0);
    for (const s of twin) {
      expect(s.if ?? '').toContain("steps.smoke.outcome == 'failure'");
      expect(s.run).toContain('exit 0');
    }
  });

  it('every smoke script flushes Redis before the runner (Next caches the optimized image there)', () => {
    for (const f of ['run-compat-smoke.sh', 'run-compat-smoke-image.sh']) {
      // Commands only: the headers name both scripts in prose.
      const code = readFileSync(resolve(SCRIPTS_DIR, f), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      const flush = code.indexOf('node packages/ffi/scripts/redis-flush.mjs');
      const runner = code.indexOf('node apps/file-manager/scripts/compat-smoke.mjs');
      expect(flush).toBeGreaterThan(0);
      expect(runner).toBeGreaterThan(flush);
    }
  });
});
