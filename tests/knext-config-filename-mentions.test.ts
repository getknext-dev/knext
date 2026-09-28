import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findViolations,
  isExempt,
  OLD_NAME,
  readTrackedFiles,
} from '../scripts/check-config-filename-mentions.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * #1559 — `kn-next.config.ts` -> `knext.config.ts`, NO dual-read.
 *
 * Guards that no user-facing surface (docs, scaffold templates, CLI messages,
 * package READMEs, the GitHub Action) still names the pre-rename filename —
 * except the ONE place that is SUPPOSED to: the migration error in
 * `packages/kn-next/src/cli/shared.ts`. Mutation-proved (workflow.md: "a
 * guard that stays green when its subject is removed is decoration"): both a
 * planted violation and the legitimate exemption are asserted, not just the
 * real repo's current clean state.
 */
describe('findViolations — the scan logic itself (mutation-proof)', () => {
  it('reports a planted mention outside the allowlist', () => {
    const violations = findViolations([
      { path: 'apps/docs/content/docs/made-up-page.mdx', content: 'See `kn-next.config.ts`.' },
    ]);
    expect(violations).toEqual(['apps/docs/content/docs/made-up-page.mdx:1']);
  });

  it('reports the correct line number for a mention past line 1', () => {
    const violations = findViolations([
      {
        path: 'README.md',
        content: 'line one\nline two\nsays kn-next.config here\nline four',
      },
    ]);
    expect(violations).toEqual(['README.md:3']);
  });

  it('does NOT report a clean file', () => {
    expect(findViolations([{ path: 'README.md', content: 'says knext.config.ts here' }])).toEqual(
      [],
    );
  });

  it('does NOT report the one allowed file — the migration error itself', () => {
    expect(
      findViolations([
        {
          path: 'packages/kn-next/src/cli/shared.ts',
          content: 'const LEGACY_CONFIG_FILE = "kn-next.config.ts";',
        },
      ]),
    ).toEqual([]);
  });

  it('still reports a DIFFERENT file at the SAME path shape one directory over', () => {
    // Proves the allowlist entry is an exact path, not a loose `cli/`
    // prefix — a sibling module under the same directory must still be caught.
    expect(
      findViolations([
        {
          path: 'packages/kn-next/src/cli/deploy.ts',
          content: 'mentions kn-next.config.ts here',
        },
      ]),
    ).toEqual(['packages/kn-next/src/cli/deploy.ts:1']);
  });

  it('does NOT report test files, CHANGELOG.md, ADRs, verification notes, or changesets', () => {
    const clean = [
      { path: 'packages/kn-next/src/__tests__/whatever.test.ts', content: 'kn-next.config.ts' },
      {
        path: 'packages/kn-next/src/__tests__/fixtures/x/y.ts',
        content: 'kn-next.config.ts',
      },
      { path: 'packages/kn-next/CHANGELOG.md', content: 'kn-next.config.ts' },
      { path: 'docs/adr/0001-example.md', content: 'kn-next.config.ts' },
      { path: 'docs/verification/2026-01-01-note.md', content: 'kn-next.config.ts' },
      { path: '.changeset/pre/example.md', content: 'kn-next.config.ts' },
    ];
    expect(findViolations(clean)).toEqual([]);
  });
});

describe('isExempt — the allowlist, asserted directly', () => {
  it('exempts exactly the migration-error file, not the whole cli/ directory', () => {
    expect(isExempt('packages/kn-next/src/cli/shared.ts')).toBe(true);
    expect(isExempt('packages/kn-next/src/cli/deploy.ts')).toBe(false);
  });

  it('exempts test files by suffix and by __tests__ directory membership', () => {
    expect(isExempt('packages/kn-next/src/__tests__/loader.test.ts')).toBe(true);
    expect(isExempt('packages/kn-next/src/foo.spec.ts')).toBe(true);
    expect(isExempt('packages/kn-next/src/__tests__/fixtures/app/knext.config.ts')).toBe(true);
    expect(isExempt('packages/kn-next/src/cli/build.ts')).toBe(false);
  });

  it('exempts dated history: ADRs, verification notes, changesets, CHANGELOG.md', () => {
    expect(isExempt('docs/adr/0060-example.md')).toBe(true);
    expect(isExempt('docs/verification/948-example.md')).toBe(true);
    expect(isExempt('.changeset/pre/example.md')).toBe(true);
    expect(isExempt('packages/kn-next/CHANGELOG.md')).toBe(true);
  });

  it('does NOT exempt an ordinary doc page or template', () => {
    expect(isExempt('apps/docs/content/docs/cli.mdx')).toBe(false);
    expect(isExempt('packages/kn-next/templates/app/knext.config.ts.hbs')).toBe(false);
    expect(isExempt('README.md')).toBe(false);
  });

  it("exempts .claude/ and the root CLAUDE.md — not an agent's to edit for this issue", () => {
    expect(isExempt('.claude/rules/workflow.md')).toBe(true);
    expect(isExempt('.claude/skills/knext-app/SKILL.md')).toBe(true);
    expect(isExempt('CLAUDE.md')).toBe(true);
    // A DIFFERENT file literally named CLAUDE.md nested elsewhere is not the
    // one this exemption means — exact root path only.
    expect(isExempt('packages/kn-next/CLAUDE.md')).toBe(false);
  });
});

describe('the real repo, scanned end to end', () => {
  it('the scanner finds a non-trivial number of tracked files (a scan finding nothing proves nothing)', () => {
    const files = readTrackedFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(500);
  });

  it('the allowed file genuinely still carries the old name — the exemption is not vacuous', () => {
    const files = readTrackedFiles(REPO_ROOT);
    const shared = files.find((f) => f.path === 'packages/kn-next/src/cli/shared.ts');
    expect(shared).toBeDefined();
    expect(shared?.content).toContain(OLD_NAME);
  });

  it('no user-facing string, template, or doc says kn-next.config outside the migration error', () => {
    const violations = findViolations(readTrackedFiles(REPO_ROOT));
    expect(violations).toEqual([]);
  });
});
