/**
 * A workflow that names a test file must invoke the runner that file belongs to.
 *
 * ## The failure
 *
 * Two `ci.yml` steps ran `vitest run <path>` against files that had migrated to
 * `bun:test`. vitest's config excludes those, so the step collected nothing:
 *
 *   No test files found, exiting with code 1
 *   filter: packages/kn-next/src/__tests__/compile-cache-health-bun.test.ts
 *
 * Exit 1 is loud, so this was not silent — but it fails for a reason that says
 * nothing about the thing being guarded, and one of the two is the seam-alive
 * artifact gate, whose entire contract is "must NOT skip". A gate that reds
 * because its runner cannot see the file is indistinguishable, from the outside,
 * from a gate that reds because the artifact broke.
 *
 * Neither could be caught locally: `ci.yml` had never run against the branch
 * that migrated those files, because there was no PR.
 *
 * ## Why this is not covered by the partition guard
 *
 * `tests/runner-partition.test.ts` asserts every test file is claimed by exactly
 * one runner. That is about the FILES. This is about the CALL SITES: a workflow
 * can name a correctly-partitioned file and still hand it to the wrong runner.
 * The two guards fail on different mistakes, and the second one is the reason
 * seven CI jobs were red.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsFrom } from '../scripts/lib/test-framework-import.mjs';

/**
 * Stands in for a `${{ … }}` expression while splitting on whitespace. It must
 * be a single non-space token: collapsing the template to a SPACE splits
 * `apps/${{ matrix.app }}/x.test.ts` into `apps/` and `/x.test.ts`, and the
 * second half then resolves against nothing.
 */
const PLACEHOLDER = '\u0000';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = resolve(repoRoot, '.github/workflows');

interface Invocation {
  workflow: string;
  runner: 'vitest' | 'bun';
  file: string;
}

/**
 * Every `vitest run <file>` / `bun-test.mjs <file>` in a workflow that names a
 * concrete `.test.ts`.
 *
 * Reads each step's `run` from the PARSED YAML rather than regexing file text,
 * and that is not a style preference. The first version matched
 * `vitest run ([^\n|&;]+)` against raw text, and a FOLDED SCALAR
 *
 *     run: >-
 *       bun x vitest run
 *       apps/file-manager/sigterm-drain-e2e.test.ts
 *       apps/file-manager/sigterm-hardcap-e2e.test.ts
 *
 * puts the arguments on their own lines. The line-bounded capture matched
 * `bun x vitest run` with NO files, found nothing to check, and passed — while
 * that exact step was failing in CI for the reason this guard exists to catch.
 * The YAML parser joins the scalar, so the wrapping cannot hide a call site.
 *
 * A `${{ matrix.app }}` path is expanded against the directories that really
 * contain such a file, rather than skipped — the seam-alive gate is
 * matrix-templated, and skipping templated paths would exempt the other call
 * site that was broken.
 */
function invocations(): Invocation[] {
  const out: Invocation[] = [];
  for (const wf of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
    // biome-ignore lint/suspicious/noExplicitAny: the workflow schema is not modelled here
    const doc = (Bun as any).YAML.parse(readFileSync(resolve(workflowDir, wf), 'utf8'));
    const jobs = Object.values(doc?.jobs ?? {}) as { steps?: { run?: string }[] }[];
    for (const job of jobs) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        const runner: Invocation['runner'] | null = /\bvitest run\b/.test(step.run)
          ? 'vitest'
          : /bun-test\.mjs\b/.test(step.run)
            ? 'bun'
            : null;
        if (!runner) continue;
        // Collapse `${{ … }}` to a space BEFORE splitting on whitespace: the
        // template itself contains spaces, so a naive split shatters
        // `apps/${{ matrix.app }}/x.test.ts` into three tokens and the real path
        // is never seen.
        const collapsed = step.run.replace(/\$\{\{[^}]*\}\}/g, PLACEHOLDER);
        for (const token of collapsed.split(/\s+/)) {
          if (!/\.test\.tsx?$/.test(token)) continue;
          for (const file of expand(token)) out.push({ workflow: wf, runner, file });
        }
      }
    }
  }
  return out;
}

/** Resolve a possibly `${{ … }}`-templated path to the real files it can name. */
function expand(token: string): string[] {
  if (!token.includes(PLACEHOLDER)) return [token];
  const [prefix, suffix] = token.split(PLACEHOLDER);
  const base = resolve(repoRoot, prefix);
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  return entries
    .map((e) => `${prefix}${e}${suffix}`)
    .filter((p) => {
      try {
        readFileSync(resolve(repoRoot, p), 'utf8');
        return true;
      } catch {
        return false;
      }
    });
}

function runnerFor(file: string): 'vitest' | 'bun' | 'unknown' {
  let src: string;
  try {
    src = readFileSync(resolve(repoRoot, file), 'utf8');
  } catch {
    return 'unknown';
  }
  if (importsFrom(src, 'bun:test')) return 'bun';
  if (importsFrom(src, 'vitest')) return 'vitest';
  return 'unknown';
}

describe('workflows invoke the runner each named test file belongs to', () => {
  it('finds workflow test invocations at all — the guard must not pass vacuously', () => {
    // Templated paths are expanded, so this counts real files. If it ever drops
    // to zero the assertion below is meaningless and this fails first.
    expect(invocations().length).toBeGreaterThan(0);
  });

  it('no workflow hands a test file to the wrong runner', () => {
    const wrong = invocations()
      .map(({ workflow, runner, file }) => {
        const owner = runnerFor(file);
        if (owner === 'unknown') return `${workflow}: ${file} — imports neither runner`;
        return owner === runner
          ? null
          : `${workflow}: runs ${file} under ${runner}, but it imports ${owner}`;
      })
      .filter((x): x is string => x !== null)
      .sort();

    expect(
      wrong,
      'the runner collects nothing and the step dies with `No test files found` — a ' +
        'failure that says nothing about the artifact the step guards. Use ' +
        '`node scripts/bun-test.mjs <file>` for a `bun:test` file; it exits 1 on an ' +
        'empty selection too, so a missing or renamed file still fails loudly.',
    ).toEqual([]);
  });
});
