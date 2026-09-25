/**
 * Guard: no source file may import the bare `typescript` package as a
 * library (#1402).
 *
 * `typescript@7`'s default export ships only `{ version, versionMajorMinor }`
 * — the classic compiler API (`createSourceFile`, `forEachChild`, the
 * `isXxx` node-type guards) that this repo's AST-walking scripts/tests/CLI
 * scanner need is gone from it (confirmed by direct install+inspection,
 * `.claude/research/ts7-migration-plan.md`). Those 11 call sites import the
 * aliased `typescript-api` devDependency (pinned at 5.9.x) instead, which
 * still has the full API.
 *
 * `typescript` itself stays a devDependency everywhere for `tsc`
 * typechecking (fast, TS7-native) — it just must never be `import`ed as a
 * JS module. A future file that types `import ts from 'typescript'` gets
 * the version-stamp-only default export and breaks at first use, so this
 * guard catches it at authoring time instead of at a confusing runtime
 * `ts.createSourceFile is not a function`.
 *
 * SCANS rather than enumerates known files (per `.claude/rules/workflow.md`
 * — "prefer scanning to enumerating; an enumerated list is how the second
 * one gets missed"), so a new AST-walking script added anywhere in the repo
 * is covered automatically, not just the 11 files fixed by this PR.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

/** This file's own repo-relative path — excluded from the scan below because
 * it legitimately contains raw `'typescript'`-shaped import strings as
 * fixtures for its own self-test, which are not real imports. */
const SELF = 'tests/no-raw-typescript-import.test.ts';

/** Every tracked `.ts`/`.tsx`/`.mjs`/`.js` file in the repo, via git — never
 * `node_modules`, `dist`, or other build output, because git doesn't track
 * those. */
function trackedSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', '*.ts', '*.tsx', '*.mjs', '*.js'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return (
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // .d.ts files never contain runtime imports worth scanning.
      .filter((f) => !f.endsWith('.d.ts'))
      .filter((f) => f !== SELF)
  );
}

// Matches `import ... from 'typescript'`, `import ... from "typescript"`,
// and `require('typescript')` / `require("typescript")` — but NOT
// `typescript-api`, `typescript/unstable/...`, or `@types/typescript`
// (there's no such package, but the regex must not accidentally match a
// longer specifier that merely starts with "typescript").
const RAW_TYPESCRIPT_IMPORT = /(?:from\s+['"]typescript['"]|require\(\s*['"]typescript['"]\s*\))/;

describe('no file imports the bare `typescript` package as a library (#1402)', () => {
  it('every tracked source file uses `typescript-api`, not `typescript`, for the compiler API', () => {
    const offenders: string[] = [];
    for (const file of trackedSourceFiles()) {
      const abs = join(REPO_ROOT, file);
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue; // a file git tracks but the working tree lacks (rare) — skip
      }
      if (RAW_TYPESCRIPT_IMPORT.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Anti-vacuity: the guard must actually be able to see a violation, not
  // just report an empty list because the regex never matches anything.
  it('the detector itself matches a known-bad import (mutation-proof)', () => {
    expect(RAW_TYPESCRIPT_IMPORT.test("import ts from 'typescript';")).toBe(true);
    expect(RAW_TYPESCRIPT_IMPORT.test('import ts from "typescript";')).toBe(true);
    expect(RAW_TYPESCRIPT_IMPORT.test("const ts = require('typescript');")).toBe(true);
    // The alias and subpath exports must NOT trip the guard.
    expect(RAW_TYPESCRIPT_IMPORT.test("import ts from 'typescript-api';")).toBe(false);
    expect(
      RAW_TYPESCRIPT_IMPORT.test("import { isCallExpression } from 'typescript/unstable/ast/is';"),
    ).toBe(false);
  });
});
