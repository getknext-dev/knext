/**
 * The docs-closure gate scans an SBOM, and this is what keeps that honest (#878).
 *
 * ## The defect this replaced
 *
 * The gate scanned `.docs-closure/pnpm-lock.yaml`. Moving the repo to bun makes
 * that file disappear, and the obvious swap — point Trivy at `bun.lock` — was
 * measured as strictly worse:
 *
 *   pnpm-lock.yaml   777 packages   1 HIGH (CVE-2026-33671 picomatch@2.3.1)
 *   bun.lock         509 packages   0 HIGH
 *
 * `picomatch@2.3.1` IS in `bun.lock`, under a nested `"micromatch/picomatch"`
 * key Trivy's bun parser does not descend into. The swap would have moved a
 * security gate from catching that HIGH to missing it, while still going green.
 *
 * ## What is asserted here, and what is not
 *
 * These are STRUCTURAL guards on the generator and the two workflow wirings.
 * They deliberately do not run Trivy — that needs a vulnerability database and
 * a network, and a test that silently degrades to "no findings" when offline
 * would be the same class of defect this whole change is about.
 *
 * The vulnerability-detection property is proved instead by the gate itself:
 * the SBOM built from the real closure reports CVE-2026-33671 and exits 1, the
 * same finding the old lockfile scan produced.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const SCRIPT = 'scripts/sbom-docs-closure.mjs';
const SBOM_REF = './.docs-closure/closure.cdx.json';

/** Run the generator, returning its exit code and whether it wrote anything. */
function runGenerator(workspace: string, out: string): { code: number; wrote: boolean } {
  let code = 0;
  try {
    execFileSync('node', [resolve(repoRoot, SCRIPT), workspace, out], { stdio: 'pipe' });
  } catch (err) {
    code = (err as { status?: number }).status ?? 1;
  }
  return { code, wrote: existsSync(out) };
}

/** A throwaway workspace with `count` fake installed packages. */
function fakeWorkspace(count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'knext-sbom-'));
  const deps: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const name = `pkg-${i}`;
    deps[name] = '1.0.0';
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'ws', version: '0.0.0', dependencies: deps }),
  );
  return root;
}

describe('the docs-closure SBOM generator fails closed (#878)', () => {
  it('refuses an implausibly small closure, and writes NOTHING', () => {
    // Measured: `trivy sbom` on a MISSING file exits 1, but on an SBOM with
    // zero components it exits 0. So an empty SBOM is a silent pass — the gate
    // reports no vulnerabilities and proves nothing. The generator must fail
    // before the file exists, or a later step scans something that looks clean.
    const out = join(mkdtempSync(join(tmpdir(), 'knext-sbom-out-')), 'closure.cdx.json');
    const { code, wrote } = runGenerator(fakeWorkspace(0), out);
    expect(code).toBe(1);
    expect(wrote).toBe(false);
  });

  it('refuses a workspace that does not exist', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'knext-sbom-out-')), 'closure.cdx.json');
    const { code, wrote } = runGenerator(join(tmpdir(), 'knext-nope-does-not-exist'), out);
    expect(code).toBe(1);
    expect(wrote).toBe(false);
  });

  it('emits a scannable CycloneDX document for a plausible closure', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'knext-sbom-out-')), 'closure.cdx.json');
    const { code, wrote } = runGenerator(fakeWorkspace(60), out);
    expect(code).toBe(0);
    expect(wrote).toBe(true);
    const bom = JSON.parse(readFileSync(out, 'utf8'));
    expect(bom.bomFormat).toBe('CycloneDX');
    expect(bom.components.length).toBeGreaterThanOrEqual(60);
    // purls are what Trivy matches advisories on. A component without one is
    // present in the document and invisible to the scanner — the silent-miss
    // shape again, one level down.
    for (const c of bom.components) expect(c.purl).toMatch(/^pkg:npm\//);
  });

  it('excludes vendored copies that are not at a canonical package path', () => {
    // `next/dist/compiled/picomatch` is real code, but rebranded and often
    // patched, so its version string does not describe what is there. Counting
    // such copies added 22 HIGH findings against versions not actually present
    // — the fastest way to teach people to ignore a gate.
    const root = fakeWorkspace(60);
    // `picomatch` must be REACHABLE by name, or the traversal excludes it for a
    // reason that has nothing to do with the filter — which is how the first
    // version of this test passed while the filter was disabled. A mutation run
    // caught it: deleting the canonical check left this green.
    const parent = join(root, 'node_modules', 'pkg-0');
    writeFileSync(
      join(parent, 'package.json'),
      JSON.stringify({
        name: 'pkg-0',
        version: '1.0.0',
        dependencies: { picomatch: '2.3.1' },
      }),
    );
    const vendored = join(parent, 'dist', 'compiled', 'picomatch');
    mkdirSync(vendored, { recursive: true });
    writeFileSync(
      join(vendored, 'package.json'),
      JSON.stringify({ name: 'picomatch', version: '2.3.1' }),
    );
    const out = join(mkdtempSync(join(tmpdir(), 'knext-sbom-out-')), 'closure.cdx.json');
    runGenerator(root, out);
    const names = JSON.parse(readFileSync(out, 'utf8')).components.map(
      (c: { name: string }) => c.name,
    );
    expect(names).not.toContain('picomatch');
  });

  it('excludes devDependencies — they do not reach the image', () => {
    const root = fakeWorkspace(60);
    const devOnly = join(root, 'node_modules', 'only-a-dev-dep');
    mkdirSync(devOnly, { recursive: true });
    writeFileSync(
      join(devOnly, 'package.json'),
      JSON.stringify({ name: 'only-a-dev-dep', version: '9.9.9' }),
    );
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    manifest.devDependencies = { 'only-a-dev-dep': '9.9.9' };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    const out = join(mkdtempSync(join(tmpdir(), 'knext-sbom-out-')), 'closure.cdx.json');
    runGenerator(root, out);
    const names = JSON.parse(readFileSync(out, 'utf8')).components.map(
      (c: { name: string }) => c.name,
    );
    expect(names).not.toContain('only-a-dev-dep');
    expect(names).toContain('pkg-0');
  });

  it('follows transitive runtime edges, not just direct ones', () => {
    // The finding that motivated this change is three hops deep:
    // fast-glob -> micromatch -> picomatch@2.3.1. A traversal that stopped at
    // direct dependencies would miss it and still look like it was working.
    const root = fakeWorkspace(60);
    for (const [name, deps] of [
      ['level-one', { 'level-two': '1.0.0' }],
      ['level-two', { 'level-three': '1.0.0' }],
      ['level-three', {}],
    ] as [string, Record<string, string>][]) {
      const dir = join(root, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', dependencies: deps }),
      );
    }
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    manifest.dependencies['level-one'] = '1.0.0';
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    const out = join(mkdtempSync(join(tmpdir(), 'knext-sbom-out-')), 'closure.cdx.json');
    runGenerator(root, out);
    const names = JSON.parse(readFileSync(out, 'utf8')).components.map(
      (c: { name: string }) => c.name,
    );
    expect(names).toContain('level-three');
  });
});

describe('both workflows generate the SBOM before scanning it (#878)', () => {
  const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/docs-closure-nightly.yml'];

  /** Every `run:` string in the file, flattened. */
  function runSteps(path: string): string[] {
    const doc = parse(read(path)) as {
      jobs: Record<
        string,
        { steps?: { run?: string; uses?: string; with?: Record<string, string> }[] }
      >;
    };
    return Object.values(doc.jobs).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ''));
  }

  it.each(WORKFLOWS)('%s installs the closure and builds the SBOM', (wf) => {
    const runs = runSteps(wf).join('\n');
    // Without the install there is no tree to read, and without the generator
    // there is no file to scan. Trivy exits 1 on a missing file, so this would
    // fail loudly rather than silently — but it would fail on every run, which
    // is its own way of getting a gate disabled.
    expect(runs).toContain('bun install');
    expect(runs).toContain(SCRIPT);
  });

  it.each(WORKFLOWS)('%s scans the generated SBOM, not a lockfile', (wf) => {
    const doc = parse(read(wf)) as {
      jobs: Record<string, { steps?: { with?: Record<string, string> }[] }>;
    };
    const trivy = Object.values(doc.jobs)
      .flatMap((j) => j.steps ?? [])
      .map((s) => s.with)
      .filter((w): w is Record<string, string> => w?.['scan-ref'] === SBOM_REF);
    expect(trivy.length).toBeGreaterThan(0);
    for (const cfg of trivy) {
      expect(cfg['scan-type']).toBe('sbom');
      expect(cfg.severity).toBe('HIGH,CRITICAL');
      expect(cfg['exit-code']).toBe('1');
    }
  });

  it('no workflow still points the docs gate at a lockfile', () => {
    // Scanned rather than enumerated: re-adding a lockfile scan-ref anywhere
    // reds this, including in a workflow that does not exist yet.
    for (const wf of WORKFLOWS) {
      expect(read(wf)).not.toContain('.docs-closure/pnpm-lock.yaml');
      expect(read(wf)).not.toContain('.docs-closure/bun.lock');
    }
  });
});
