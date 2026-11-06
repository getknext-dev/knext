/**
 * Every go.mod in the repo is either govulncheck-gated in CI (through the
 * fail-closed gate, at the one pinned version, under pipefail, on PRs and pushes
 * touching the module) or listed in security/govulncheck-modules.json with a
 * reason. A new, unlisted module fails here, so the scan can't silently cover
 * only templates/go again.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WF_DIR = resolve(REPO_ROOT, '.github/workflows');

const modules = execFileSync('git', ['ls-files', '--', '*go.mod'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((p) => p && /(^|\/)go\.mod$/.test(p) && !/(^|\/)(vendor|testdata|node_modules)\//.test(p))
  .map((p) => p.replace(/\/?go\.mod$/, '') || '.');

const excluded: { path: string; reason: string }[] = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'security/govulncheck-modules.json'), 'utf8'),
).excluded;

type Gated = { file: string; dir: string; wf: any; step: any };

function gatedModules(): Gated[] {
  const out: Gated[] = [];
  for (const file of readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const wf = parse(readFileSync(resolve(WF_DIR, file), 'utf8'));
    for (const job of Object.values<any>(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!step.run?.includes('govulncheck-gate.mjs') || !step.run.includes('govulncheck@'))
          continue;
        const wd: string = step['working-directory'] ?? '.';
        const dirs = wd.includes('${{ matrix.module }}')
          ? (job.strategy?.matrix?.module ?? [])
          : [wd];
        for (const dir of dirs) out.push({ file, dir, wf, step });
      }
    }
  }
  return out;
}

const NIGHTLY = 'govulncheck-nightly.yml';
const allGated = gatedModules();
// A schedule-only run is not PR-time coverage: a module must be gated by at least
// one PR/push workflow that is NOT the nightly.
const gated = allGated.filter((g) => g.file !== NIGHTLY);

describe('govulncheck covers every Go module', () => {
  it('finds the known modules (the scan itself is not vacuous)', () => {
    expect(modules).toContain('packages/kn-next-operator');
    expect(modules).toContain('packages/scale-zero-pg/gateway');
  });

  it('every go.mod is gated in CI or excluded with a reason', () => {
    const gatedDirs = new Set(gated.map((g) => g.dir));
    const excludedDirs = new Set(excluded.map((e) => e.path));
    const missing = modules.filter((m) => !gatedDirs.has(m) && !excludedDirs.has(m));
    expect(missing).toEqual([]);
  });

  it('a module is not both gated and excluded, and no entry is stale', () => {
    const gatedDirs = new Set(gated.map((g) => g.dir));
    for (const e of excluded) {
      expect(gatedDirs.has(e.path), `${e.path} is gated AND excluded`).toBe(false);
      expect(modules, `${e.path} is excluded but has no go.mod`).toContain(e.path);
      expect(e.reason.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('every gated directory really is a module', () => {
    for (const g of gated) expect(modules, `${g.file}: ${g.dir}`).toContain(g.dir);
  });

  it('each gated step is pipefail, fail-closed, and on one pinned version', () => {
    const versions = new Set<string>();
    for (const { file, step } of gated) {
      expect(step.run, file).toContain('set -euo pipefail');
      expect(step.run, file).toMatch(
        /govulncheck@v\d+\.\d+\.\d+ -format json \.\/\.\.\. \| node [^\n]*govulncheck-gate\.mjs/,
      );
      versions.add(step.run.match(/govulncheck@(v\d+\.\d+\.\d+)/)[1]);
    }
    expect([...versions]).toEqual(['v1.9.0']);
  });

  it('every gated module is scanned on PRs and pushes that touch it', () => {
    for (const { file, dir, wf } of gated) {
      for (const ev of ['pull_request', 'push']) {
        const paths: string[] = wf.on?.[ev]?.paths ?? [];
        // A schedule-only workflow (the nightly) has no path filter; accept it
        // only if it has no path filter on this event either.
        const unfiltered = wf.on?.[ev] && !wf.on[ev].paths;
        const covers = unfiltered || paths.some((p) => p === `${dir}/**`);
        expect(covers, `${file} ${ev} must cover ${dir}/**`).toBe(true);
      }
    }
  });

  it('the nightly scans every gated module too, so an exception expires on its date', () => {
    const nightly = new Set(allGated.filter((g) => g.file === NIGHTLY).map((g) => g.dir));
    for (const g of gated) expect(nightly.has(g.dir), `nightly must scan ${g.dir}`).toBe(true);
  });

  it('GO-2026-6809 is no longer excepted: go1.26.10 fixes it in every module (#2567)', () => {
    const ex = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'security/govulncheck-exceptions.json'), 'utf8'),
    );
    expect(ex.allow.map((a: any) => a.id)).not.toContain('GO-2026-6809');
  });

  it('the new workflow holds read-only permissions and SHA-pinned actions', () => {
    const text = readFileSync(resolve(WF_DIR, 'govulncheck-modules.yml'), 'utf8');
    expect(parse(text).permissions).toEqual({ contents: 'read' });
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(rest).toMatch(/#\s*v\d/);
    }
  });
});
