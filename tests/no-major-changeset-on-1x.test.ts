import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PUBLISH_LANES } from '../scripts/publish-lane-guard.mjs';

/**
 * GUARD (#2036, v2 R1): no `major` changeset for a member of the `fixed` group
 * while that group is on 1.x. PR-time complement to the publish-time lane guard.
 *
 * History: a stale "1.0 milestone" major changeset made `changeset version`
 * compute 2.0.0 on the 1.3 line. Files are SCANNED, not enumerated, and a
 * changeset whose front-matter cannot be parsed FAILS (never skipped).
 */

const ROOT = resolve(import.meta.dir, '..');
const LEVELS = new Set(['major', 'minor', 'patch']);

/**
 * The lane a run belongs to: the PR target (`GITHUB_BASE_REF`), else the pushed
 * ref (`GITHUB_REF_NAME`), else the checked-out branch. A PR is judged by where it
 * lands, not by its feature-branch name.
 */
function currentBranch(env: Record<string, string | undefined> = process.env): string {
  if (env.GITHUB_BASE_REF) return env.GITHUB_BASE_REF;
  if (env.GITHUB_REF_NAME) return env.GITHUB_REF_NAME;
  const r = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/**
 * Majors are legitimate only where the lane map says the lane publishes a major
 * of 2 or more. The map is imported, never re-listed, so a lane is added in one
 * place (`scripts/publish-lane-guard.mjs`). An unknown or empty branch is not a
 * lane: the answer is no (fail closed).
 */
function majorsAllowedOn(branch: string): boolean {
  const major = PUBLISH_LANES.get(`refs/heads/${branch}`);
  return major !== undefined && major >= 2;
}

/** Parse changeset front-matter into {package: level}. Throws on anything malformed. */
function parseFrontMatter(file: string, text: string): Record<string, string> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new Error(`${file}: missing opening '---' front-matter`);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) throw new Error(`${file}: unterminated front-matter (no closing '---')`);
  const out: Record<string, string> = {};
  for (const raw of lines.slice(1, end)) {
    if (raw.trim() === '') continue;
    const m = raw.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s:'"]+))\s*:\s*['"]?(\w+)['"]?\s*$/);
    if (!m) throw new Error(`${file}: malformed front-matter line: ${JSON.stringify(raw)}`);
    const name = m[1] ?? m[2] ?? m[3];
    const level = m[4];
    if (!LEVELS.has(level)) throw new Error(`${file}: invalid bump level '${level}' for ${name}`);
    out[name] = level;
  }
  return out;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** name -> version for every workspace package under packages/ */
function packageVersions(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const dir = join(root, 'packages');
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let pj: any;
    try {
      pj = readJson(join(dir, d.name, 'package.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    if (pj.name && pj.version) m.set(pj.name, pj.version);
  }
  return m;
}

/** Returns human-readable violations; throws on unparseable input. */
function findViolations(root: string, branch = ''): string[] {
  const cs = join(root, '.changeset');
  const config = readJson(join(cs, 'config.json'));
  const fixed: string[] = (config.fixed ?? []).flat();
  // Fail closed: a renamed/removed/empty `fixed` would otherwise let every major through.
  if (!Array.isArray(config.fixed) || fixed.length === 0)
    throw new Error(
      '.changeset/config.json: `fixed` group is missing or empty; this guard cannot protect the 1.x line without it',
    );
  const versions = packageVersions(root);
  // Fail closed: every fixed member must resolve to a version.
  for (const n of fixed) {
    if (!versions.get(n))
      throw new Error(
        `.changeset/config.json: fixed member ${n} does not resolve to a packages/*/package.json version`,
      );
  }
  const files = readdirSync(cs);
  const bumps = new Map<string, Record<string, string>>();
  for (const f of files) {
    if (!f.endsWith('.md') || f.toLowerCase() === 'readme.md') continue;
    bumps.set(f, parseFrontMatter(f, readFileSync(join(cs, f), 'utf8')));
  }
  // pre.json `changesets` lists ids; any whose .md is still present is already
  // scanned above. A listed id that is NOT on disk has no recoverable bump
  // level, so it cannot be checked here — but the file scan above is by
  // directory listing, so a re-added file is always caught.
  if (files.includes('pre.json')) {
    const pre = readJson(join(cs, 'pre.json'));
    if (!Array.isArray(pre.changesets ?? []))
      throw new Error('pre.json: `changesets` is not an array');
  }
  const out: string[] = [];
  for (const [file, b] of bumps) {
    for (const [pkg, level] of Object.entries(b)) {
      if (level !== 'major' || !fixed.includes(pkg)) continue;
      if (majorsAllowedOn(branch)) continue;
      // fixed group shares one version; fall back to any group member's version
      const v = versions.get(pkg) as string;
      if (v.startsWith('1.')) {
        out.push(
          `.changeset/${file}: 'major' bump of fixed-group package ${pkg} while the group is on ${v}; this would compute 2.0.0 on the 1.x line. Use minor/patch.`,
        );
      }
    }
  }
  return out;
}

describe('no major changeset on a 1.x fixed group (#2036)', () => {
  it('the repository has no such changeset', () => {
    expect(findViolations(ROOT, currentBranch())).toEqual([]);
  });

  describe('detector self-checks (temp fixtures)', () => {
    const tempRoots: string[] = [];
    afterAll(() => {
      for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
    });
    const fixture = (
      cs: Record<string, string>,
      config: unknown = { fixed: [['@getknext/core', '@getknext/lib']] },
    ) => {
      const r = mkdtempSync(join(tmpdir(), 'r1-'));
      tempRoots.push(r);
      mkdirSync(join(r, '.changeset'));
      mkdirSync(join(r, 'packages/core'), { recursive: true });
      writeFileSync(join(r, '.changeset/config.json'), JSON.stringify(config));
      mkdirSync(join(r, 'packages/lib'), { recursive: true });
      writeFileSync(
        join(r, 'packages/lib/package.json'),
        JSON.stringify({ name: '@getknext/lib', version: '1.3.0' }),
      );
      writeFileSync(
        join(r, 'packages/core/package.json'),
        JSON.stringify({ name: '@getknext/core', version: '1.3.0' }),
      );
      for (const [k, v] of Object.entries(cs)) writeFileSync(join(r, '.changeset', k), v);
      return r;
    };
    it('flags a major bump', () => {
      expect(
        findViolations(fixture({ 'a.md': '---\n"@getknext/core": major\n---\n\nx\n' })),
      ).toHaveLength(1);
    });
    it('accepts minor/patch and empty changesets', () => {
      expect(
        findViolations(
          fixture({
            'a.md': '---\n"@getknext/core": minor\n"@getknext/lib": patch\n---\nx',
            'b.md': '---\n---\n',
          }),
        ),
      ).toEqual([]);
    });
    describe('majors are allowed on the v2 lane only (#2038, v2 R3a)', () => {
      const major = { 'a.md': '---\n"@getknext/core": major\n---\n\nx\n' };
      it('accepts a major when the branch is integration/v2', () => {
        expect(findViolations(fixture(major), 'integration/v2')).toEqual([]);
      });
      it.each([
        'main',
        'integration/v1.3',
        'integration/v1.4',
        'release/1.x',
        'integration/v1-coldstart',
        'integration/v2.0',
        'feat/integration/v2',
        '',
      ])('still flags a major when the branch is %p', (branch) => {
        expect(findViolations(fixture(major), branch)).toHaveLength(1);
      });
      it('reads the lane from the PR target first, then the pushed ref, then git', () => {
        expect(currentBranch({ GITHUB_BASE_REF: 'integration/v2', GITHUB_REF_NAME: 'x' })).toBe(
          'integration/v2',
        );
        expect(currentBranch({ GITHUB_BASE_REF: '', GITHUB_REF_NAME: 'main' })).toBe('main');
      });
    });
    it('ignores major on a non-fixed package', () => {
      expect(findViolations(fixture({ 'a.md': '---\n"other": major\n---\n' }))).toEqual([]);
    });
    it('fails closed when the fixed group is renamed, removed or empty', () => {
      const cs = { 'a.md': '---\n"@getknext/core": major\n---\n' };
      expect(() => findViolations(fixture(cs, { fixedX: [['@getknext/core']] }))).toThrow(/fixed/);
      expect(() => findViolations(fixture(cs, {}))).toThrow(/fixed/);
      expect(() => findViolations(fixture(cs, { fixed: [] }))).toThrow(/fixed/);
      expect(() => findViolations(fixture(cs, { fixed: [[]] }))).toThrow(/fixed/);
    });
    it('fails closed when a fixed member does not resolve, naming it', () => {
      const cs = { 'a.md': '---\n"@getknext/core": major\n---\n' };
      expect(() =>
        findViolations(fixture(cs, { fixed: [['@getknext/core', '@getknext/ghost']] })),
      ).toThrow(/@getknext\/ghost/);
    });
    it('throws on malformed front-matter', () => {
      expect(() => findViolations(fixture({ 'a.md': 'no frontmatter' }))).toThrow();
      expect(() =>
        findViolations(fixture({ 'a.md': '---\n"@getknext/core" major\n---\n' })),
      ).toThrow();
      expect(() =>
        findViolations(fixture({ 'a.md': '---\n"@getknext/core": huge\n---\n' })),
      ).toThrow();
      expect(() => findViolations(fixture({ 'a.md': '---\n"@getknext/core": major\n' }))).toThrow();
    });
  });
});
