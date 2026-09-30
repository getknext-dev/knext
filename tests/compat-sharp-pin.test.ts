import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';

/**
 * #1620 follow-up: in bun CREDENTIAL mode the fixture install must get exactly
 * the sharp that has a committed musl lockfile, never whatever the registry
 * newest in Next's range is (^0.35.4 for 16.3.5). Otherwise a sharp patch
 * published mid-window turns every bun credential deploy red again.
 *
 * scripts/compat-sharp-pin.mjs extends NEXT_TEST_PKG_PATHS with
 * ["sharp", <locked version>]. The Next.js harness (test/lib/
 * create-next-install.js) turns every NEXT_TEST_PKG_PATHS entry that is not a
 * direct dependency into a workspace-root pnpm override, so the whole
 * fixture tree resolves that exact sharp. It refuses (non-zero) when the
 * version it would pin has no committed lockfile. Early-warning and the node
 * lane keep floating.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/compat-sharp-pin.mjs');
const REL = 'scripts/musl-native-lockfiles';
const RECORD = JSON.parse(
  readFileSync(resolve(REPO_ROOT, REL, 'next-sharp-resolution.json'), 'utf8'),
);
const NEXT_PATHS = '[["next","/w/next-prebuilt/next.tgz"]]';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pin(env: Record<string, string>, repoRoot = REPO_ROOT) {
  const r = spawnSync('node', [SCRIPT, '--repo-root', repoRoot], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', NEXT_TEST_PKG_PATHS: NEXT_PATHS, ...env },
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

/** A copy of the lockfile corpus with `drop` removed and the record rewritten. */
function fakeRepo(record: Record<string, string>, drop: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'sharp-pin-'));
  tmps.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(resolve(REPO_ROOT, REL), join(root, REL), { recursive: true });
  for (const d of drop) rmSync(join(root, REL, d), { recursive: true, force: true });
  writeFileSync(join(root, REL, 'next-sharp-resolution.json'), JSON.stringify(record));
  return root;
}

describe('scripts/compat-sharp-pin.mjs', () => {
  it('bun credential: pins sharp to the recorded, locked version (and keeps next)', () => {
    const r = pin({ KNEXT_COMPAT_MODE: 'credential', KNEXT_RUNTIME: 'bun' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      ['next', '/w/next-prebuilt/next.tgz'],
      ['sharp', RECORD.sharp],
    ]);
  });

  it('bun credential: REFUSES when the version it would pin has no committed sharp lockfile', () => {
    const root = fakeRepo({ ...RECORD, sharp: '0.35.6' });
    const r = pin({ KNEXT_COMPAT_MODE: 'credential', KNEXT_RUNTIME: 'bun' }, root);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('img-sharp-linuxmusl-x64-0.35.6');
  });

  it('bun credential: REFUSES when the libvips that sharp needs has no committed lockfile', () => {
    const root = fakeRepo(RECORD, [`img-sharp-libvips-linuxmusl-x64-${RECORD.libvips}`]);
    const r = pin({ KNEXT_COMPAT_MODE: 'credential', KNEXT_RUNTIME: 'bun' }, root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`img-sharp-libvips-linuxmusl-x64-${RECORD.libvips}`);
  });

  it('bun credential: REFUSES when the locked sharp lockfile pins a different libvips than recorded', () => {
    const root = fakeRepo({ ...RECORD, libvips: '1.2.4' });
    const r = pin({ KNEXT_COMPAT_MODE: 'credential', KNEXT_RUNTIME: 'bun' }, root);
    expect(r.status).not.toBe(0);
  });

  it('bun credential: refuses a sharp entry already present rather than silently overriding it', () => {
    const r = pin({
      KNEXT_COMPAT_MODE: 'credential',
      KNEXT_RUNTIME: 'bun',
      NEXT_TEST_PKG_PATHS: '[["next","/n.tgz"],["sharp","0.99.0"]]',
    });
    expect(r.status).not.toBe(0);
  });

  it('early-warning and the node lane pass NEXT_TEST_PKG_PATHS through unchanged (they float)', () => {
    for (const env of [
      { KNEXT_COMPAT_MODE: 'early-warning', KNEXT_RUNTIME: 'bun' },
      { KNEXT_COMPAT_MODE: 'credential', KNEXT_RUNTIME: 'node' },
      { KNEXT_COMPAT_MODE: '', KNEXT_RUNTIME: '' },
    ]) {
      const r = pin(env);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([['next', '/w/next-prebuilt/next.tgz']]);
    }
  });

  it('fails on a malformed NEXT_TEST_PKG_PATHS rather than guessing', () => {
    const r = pin({
      KNEXT_COMPAT_MODE: 'credential',
      KNEXT_RUNTIME: 'bun',
      NEXT_TEST_PKG_PATHS: 'nope',
    });
    expect(r.status).not.toBe(0);
  });
});

describe('test-e2e-deploy.yml runs the pin before run-tests.js, without masking its failure', () => {
  const wf = parse(
    readFileSync(resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml'), 'utf8'),
  );
  const steps: { name?: string; run?: string; shell?: string; env?: Record<string, string> }[] =
    Object.values(wf.jobs as Record<string, { steps?: unknown[] }>).flatMap(
      (j) => (j.steps ?? []) as never[],
    );
  const run = steps.filter((s) => s.run?.includes('node run-tests.js'));

  it('exactly one step runs the suite', () => {
    expect(run).toHaveLength(1);
  });

  it('the pin runs, is assigned on its own line (set -e sees a failure), and is exported before run-tests.js', () => {
    const body = run[0].run ?? '';
    const lines = body.split('\n').map((l) => l.trim());
    const assign = lines.findIndex((l) =>
      /^PINNED_PKG_PATHS="\$\(node "\$\{GITHUB_WORKSPACE\}\/knext\/scripts\/compat-sharp-pin\.mjs" --repo-root "\$\{GITHUB_WORKSPACE\}\/knext"\)"$/.test(
        l,
      ),
    );
    const exp = lines.indexOf('export NEXT_TEST_PKG_PATHS="${PINNED_PKG_PATHS}"');
    const tests = lines.findIndex((l) => l.startsWith('node run-tests.js'));
    expect(assign, 'pin assignment line').toBeGreaterThan(-1);
    expect(exp).toBeGreaterThan(assign);
    expect(tests).toBeGreaterThan(exp);
    // The script decides on these; they come from the workflow-level env and
    // the step must not shadow them with anything else.
    expect(String(wf.env.KNEXT_COMPAT_MODE)).toContain("'credential'");
    expect(String(wf.env.KNEXT_RUNTIME)).toContain("'bun'");
    expect(run[0].env?.KNEXT_COMPAT_MODE).toBeUndefined();
    // No `shell:` override: the default `bash -e` is what fails the step on a refusal.
    expect(run[0].shell).toBeUndefined();
    expect(run[0].env?.KNEXT_RUNTIME ?? '${{ env.KNEXT_RUNTIME }}').toBe(
      '${{ env.KNEXT_RUNTIME }}',
    );
  });

  it('the pin script and the record it reads are frozen for every test-e2e-deploy.yml cell', () => {
    const cells = CREDENTIAL_CELLS.filter((c) => c.workflowFile === 'test-e2e-deploy.yml');
    expect(cells.length).toBe(4);
    for (const c of cells) {
      expect(c.extraFiles).toContain('scripts/compat-sharp-pin.mjs');
      expect(c.extraFiles).toContain(`${REL}/next-sharp-resolution.json`);
    }
  });
});
