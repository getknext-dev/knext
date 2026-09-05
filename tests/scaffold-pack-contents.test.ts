import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// eslint-disable-next-line -- the script guards its executable body behind an
// entrypoint check specifically so this suite can import the pure helper.
import {
  CREATE_DIST_ENTRY,
  packedFileList,
  scaffoldPackProblems,
  TEMPLATES_PREFIX,
} from '../scripts/scaffold-pack-contents.mjs';

/**
 * #964 — the published `@getknext/core@0.3.0` tarball shipped NO `dist/cli/create.js`
 * and ZERO `templates/`, so `npx kn-next create` was dead for every stranger. HEAD
 * already ships both; these tests are the PR-time tripwire that keeps a `files`
 * allowlist edit or a dropped tsup entry from re-shipping the 0.3.0 breakage.
 *
 * Two halves, both required:
 *   - the pure helper reds on the exact 0.3.0 manifest shape (synthetic, deterministic);
 *   - the REAL `npm pack --dry-run` manifest of `packages/kn-next` carries the create
 *     verb and templates — the assertion that actually catches a config regression.
 *
 * Mirrors `tests/audit-published-sibling-ranges.test.ts` (#942): a pure `*Problems`
 * helper tested red-first, plus a real-artifact assertion.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PKG_DIR = resolve(REPO_ROOT, 'packages/kn-next');

describe('#964 scaffoldPackProblems — the front-door tarball tripwire', () => {
  it('REDS on the 0.3.0 shape: no create verb and no templates', () => {
    // The measured 0.3.0 manifest: dist/cli/* siblings but no create.js, and not a
    // single templates/ entry.
    const shipped = [
      'package.json',
      'dist/cli/kn-next.js',
      'dist/cli/build.js',
      'dist/cli/doctor.js',
      'dist/config.js',
    ];
    const problems = scaffoldPackProblems(shipped);
    expect(problems.length).toBe(2);
    expect(problems.join('\n')).toContain(CREATE_DIST_ENTRY);
    expect(problems.join('\n')).toContain(TEMPLATES_PREFIX);
  });

  it('REDS when the create verb is absent but templates ship (files kept, tsup entry dropped)', () => {
    const problems = scaffoldPackProblems(['dist/cli/kn-next.js', 'templates/app/page.tsx.hbs']);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(CREATE_DIST_ENTRY);
  });

  it('REDS when templates are absent but the create verb ships (tsup entry kept, files drops templates)', () => {
    const problems = scaffoldPackProblems(['dist/cli/kn-next.js', 'dist/cli/create.js']);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(TEMPLATES_PREFIX);
  });

  it('REDS fail-closed on an EMPTY manifest rather than passing on silence', () => {
    expect(scaffoldPackProblems([]).length).toBeGreaterThan(0);
  });

  it('stays green when both the create verb and at least one template ship', () => {
    expect(
      scaffoldPackProblems([
        'dist/cli/kn-next.js',
        'dist/cli/create.js',
        'templates/app/page.tsx.hbs',
        'templates/app/package.json.hbs',
      ]),
    ).toEqual([]);
  });

  it('normalises ./ and leading-slash prefixes so npm-pack path spellings still match', () => {
    expect(scaffoldPackProblems(['./dist/cli/create.js', '/templates/app/page.tsx.hbs'])).toEqual(
      [],
    );
  });
});

describe('#964 the REAL packed @getknext/core manifest can scaffold', () => {
  it('ships dist/cli/create.js and templates/ (reds if files or the tsup entry regresses)', () => {
    // npm pack --dry-run lists templates/ (source, always on disk) unconditionally, so
    // a `files` allowlist that drops `templates` reds here with no build. The create
    // verb is a build output; the config chain below guarantees it lands in dist.
    const files = packedFileList(PKG_DIR);
    const problems = scaffoldPackProblems(files);
    // Templates are source and must be present regardless of build state.
    expect(files.some((f) => f.replace(/^\.\//, '').startsWith(TEMPLATES_PREFIX))).toBe(true);
    // If dist is built (create.js on disk), the full guard must be clean; either way
    // templates must be present, asserted above.
    if (files.some((f) => f.replace(/^\.\//, '') === CREATE_DIST_ENTRY)) {
      expect(problems).toEqual([]);
    }
  });

  it('the config chain that puts the create verb in dist is intact', () => {
    // These are the static sources of truth the packed create.js depends on. They red
    // deterministically (no build) on the two ways 0.3.0 could recur.
    const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('templates');

    const tsup = readFileSync(resolve(PKG_DIR, 'tsup.config.ts'), 'utf8');
    expect(tsup).toContain("'cli/create': 'src/cli/create.ts'");

    // The bin dispatches the verb into that bundle.
    const deploy = readFileSync(resolve(PKG_DIR, 'src/cli/deploy.ts'), 'utf8');
    expect(deploy).toContain('sub === "create"');
    expect(deploy).toContain('./create');
  });
});
