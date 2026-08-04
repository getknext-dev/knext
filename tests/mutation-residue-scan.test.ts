import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MUTATION_MARKER } from '../scripts/lib/mutation-harness.mjs';
import { scanForResidue, scanTracked } from '../scripts/scan-mutation-residue.mjs';

/**
 * Mutation-residue scan (#645, proposal A).
 *
 * `git status --porcelain` CANNOT see mutation residue inside a file the change
 * legitimately modifies — the file reads `M` either way. Both #645 incidents hid
 * in exactly that blind spot. This scan does not consult git's status at all: it
 * asks whether any TRACKED file contains the standard marker.
 *
 * Both halves are asserted, always: it fires on a planted marker, and it does not
 * fire on the clean tree. A scan proved only on the negative half is a scan that
 * may be matching nothing.
 */

const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/scan-mutation-residue.mjs');
const CI_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/ci.yml');

const tempRepos: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-residue-scan-'));
  tempRepos.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  return dir;
}

function commitAll(dir: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir, stdio: 'pipe' });
}

afterAll(() => {
  for (const dir of tempRepos) rmSync(dir, { recursive: true, force: true });
});

describe('mutation-residue scan (#645 A)', () => {
  it('does NOT fire on the clean tree (this repo)', () => {
    expect(scanForResidue({ cwd: REPO_ROOT })).toEqual([]);
  });

  it('scans a non-trivial number of tracked files (a scan over an empty set proves nothing)', () => {
    const { scanned, offenders } = scanTracked({ cwd: REPO_ROOT });
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it('FIRES on a planted marker in a tracked file, reporting path and line', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'clean.ts'), 'export const ok = 1;\n', 'utf8');
    writeFileSync(
      join(dir, 'subject.go'),
      `package p\n\n// ${MUTATION_MARKER}: honour the withdrawn opt-in again.\nfunc f() bool { return true }\n`,
      'utf8',
    );
    commitAll(dir);

    const offenders = scanForResidue({ cwd: dir });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].path).toBe('subject.go');
    expect(offenders[0].line).toBe(3);
  });

  it('fires even when the planted file is ALSO legitimately modified — where git status is blind', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'subject.go'), 'package p\n\nfunc f() bool { return true }\n', 'utf8');
    commitAll(dir);

    // A legitimate edit the PR intends, plus residue hiding inside it.
    writeFileSync(
      join(dir, 'subject.go'),
      `package p\n\n// ${MUTATION_MARKER}\nfunc f() bool { return false }\n`,
      'utf8',
    );

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString();
    expect(status.trim()).toBe('M subject.go'); // indistinguishable from an honest edit
    expect(scanForResidue({ cwd: dir })).toHaveLength(1);
  });

  it('does not fire on UNTRACKED or git-ignored paths (build artifacts, node_modules)', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.next/\n', 'utf8');
    writeFileSync(join(dir, 'kept.ts'), 'export const ok = 1;\n', 'utf8');
    commitAll(dir);

    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), `/* ${MUTATION_MARKER} */\n`);
    mkdirSync(join(dir, '.next'), { recursive: true });
    writeFileSync(join(dir, '.next', 'bundle.js'), `/*${MUTATION_MARKER}*/\n`);

    expect(scanForResidue({ cwd: dir })).toEqual([]);
  });

  it('skips binary tracked files rather than reporting a spurious hit', () => {
    const dir = makeRepo();
    const bin = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from(MUTATION_MARKER)]);
    writeFileSync(join(dir, 'blob.bin'), bin);
    commitAll(dir);
    expect(scanForResidue({ cwd: dir })).toEqual([]);
  });

  it('the scanner does not contain the literal marker (it would flag itself)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toContain(MUTATION_MARKER);
    // ...yet it really is looking for that exact string.
    expect(scanForResidue({ cwd: REPO_ROOT })).toEqual([]);
  });

  it('runs as a CLI: exit 1 + names the file when residue exists, exit 0 when clean', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'ok.ts'), 'export const ok = 1;\n', 'utf8');
    commitAll(dir);

    const clean = spawnSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' });
    expect(clean.status).toBe(0);

    writeFileSync(join(dir, 'ok.ts'), `export const ok = 1; // ${MUTATION_MARKER}\n`, 'utf8');
    const dirty = spawnSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' });
    expect(dirty.status).toBe(1);
    expect(`${dirty.stdout}${dirty.stderr}`).toContain('ok.ts');
  });

  it('is wired into CI as a red-on-fail step and into package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['lint:mutation-residue']).toContain('scan-mutation-residue.mjs');

    const ci = readFileSync(CI_WORKFLOW, 'utf8');
    expect(ci).toContain('lint:mutation-residue');
    // No `continue-on-error` anywhere near the step: a guard that cannot fail the
    // build is decoration.
    const idx = ci.indexOf('lint:mutation-residue');
    // The KEY form, not the bare word: the step's own comment says why it carries
    // no soft-failure escape, and a substring match on the prose would be a guard
    // that fails on its own documentation.
    expect(ci.slice(Math.max(0, idx - 400), idx + 400)).not.toMatch(/continue-on-error\s*:/);
  });

  it('is documented where a harness author will look', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/guides/mutation-testing.md'), 'utf8');
    expect(doc).toContain('scan-mutation-residue.mjs');
    expect(doc).toContain('mutation-harness.mjs');
    expect(doc).toMatch(/snapshot/i);
    const contributing = readFileSync(resolve(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    expect(contributing).toContain('docs/guides/mutation-testing.md');
  });
});
