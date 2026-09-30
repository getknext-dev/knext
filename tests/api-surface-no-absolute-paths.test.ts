/**
 * #1669 round 3 (review fix) — the committed public API type-surface reports
 * must never embed an absolute local path.
 *
 * `checker.typeToString`/`signatureToString` fall back to
 * `import("<absolute path>").Foo` for a type they cannot name in the
 * printing context. Round 2's checked-in baselines had exactly that: a
 * CONTRIBUTOR's git-worktree path
 * (`/Users/…/.claude/worktrees/agent-…/packages/kn-next/src/cli/validate`)
 * and a bun-hoisted `node_modules` path
 * (`/Users/…/node_modules/.bun/drizzle-orm@0.45.2+…/node_modules/drizzle-orm/index`)
 * baked into `api-surface/core.d.ts.report` and `db.d.ts.report`. Both are
 * wrong for two reasons: the report is meant to be REGENERATED and compared
 * on every machine including CI (`/home/runner/work/knext/knext`), where the
 * absolute prefix differs and the check would fail on a pure path diff that
 * has nothing to do with the public API; and a local home/worktree path
 * leaking into a committed file is exactly the kind of thing this repo's
 * `block-secrets`-adjacent hygiene exists to catch.
 *
 * `scripts/api-surface/lib.mjs` now normalizes every `import("...")`
 * reference (repo-local → repo-relative, `node_modules` → bare package
 * specifier) and `generatePackageReport` asserts none slipped through before
 * returning. This test is the regression guard for the COMMITTED files
 * themselves — proving the guard's own output, not just its logic.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assertNoAbsolutePaths,
  PACKAGES,
  REPO_ROOT,
  reportPath,
} from '../scripts/api-surface/lib.mjs';

const ABSOLUTE_PATH_PATTERNS: RegExp[] = [/\/Users\//, /\/home\//, /[A-Za-z]:\\/];

describe('#1669: committed api-surface reports carry no absolute local path', () => {
  for (const pkg of PACKAGES) {
    it(`${pkg.name}: ${reportPath(pkg)} has no /Users/, /home/, C:\\, or the current REPO_ROOT`, () => {
      const text = readFileSync(reportPath(pkg), 'utf8');
      for (const re of ABSOLUTE_PATH_PATTERNS) {
        const match = text.match(re);
        expect(
          match,
          `${pkg.reportName}.d.ts.report contains an absolute path matching ${re}: ${match?.[0]}`,
        ).toBeNull();
      }
      expect(
        text.includes(REPO_ROOT),
        `${pkg.reportName}.d.ts.report embeds this checkout's own REPO_ROOT (${REPO_ROOT})`,
      ).toBe(false);
    });
  }

  it('assertNoAbsolutePaths throws on a /Users/ path (mutation-proof of the assertion itself)', () => {
    expect(() =>
      assertNoAbsolutePaths('function f(): import("/Users/someone/repo/src/x").Foo', 'fixture'),
    ).toThrow(/absolute local path/);
  });

  it("assertNoAbsolutePaths throws on a /home/ path (CI's checkout root)", () => {
    expect(() =>
      assertNoAbsolutePaths(
        'function f(): import("/home/runner/work/knext/knext/src/x").Foo',
        'fixture',
      ),
    ).toThrow(/absolute local path/);
  });

  it('assertNoAbsolutePaths throws on a Windows C:\\ path', () => {
    expect(() =>
      assertNoAbsolutePaths('function f(): import("C:\\\\repo\\\\src\\\\x").Foo', 'fixture'),
    ).toThrow(/absolute local path/);
  });

  it('assertNoAbsolutePaths does NOT throw on already-normalized text', () => {
    expect(() =>
      assertNoAbsolutePaths(
        'function f(config: import("packages/kn-next/src/config").KnativeNextConfig): void\n\n' +
          'external and (re-exported from drizzle-orm — upstream type, not structurally tracked)',
        'fixture',
      ),
    ).not.toThrow();
  });
});
