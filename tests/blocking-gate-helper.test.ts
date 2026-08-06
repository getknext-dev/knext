import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import { codeWithLiterals } from '../scripts/lib/prover-lane.mjs';
import { auditBlockingGate, type BlockingGateOptions } from './helpers/blocking-gate';

/**
 * Regression coverage for the AUDIT ENGINE itself (#661 round 2).
 *
 * `tests/helpers/blocking-gate.ts` is ~250 lines of detection logic whose only
 * callers (`bun-exec-hardcap-ci`, `bun-exec-alpine-image-ci`) assert
 * `problems === []` against a CLEAN workflow. That shape is blind by
 * construction: every LOOSENING of the helper is invisible to it. The round-1
 * review proved it by execution — replacing `continueOnErrorProblem`'s body with
 * `return null` and turning the `'if' in job` and fail-closed-allowlist branches
 * into `if (false)` left BOTH callers GREEN.
 *
 * `workflow.md`: "a guard that stays green when its subject is removed is
 * decoration" — and that applies to the engine, not only to the workflow it
 * audits. The round-1 mutation table was a one-time artifact, not coverage. This
 * file is the coverage: every disarm the helper claims to detect gets a
 * synthetic workflow asserting it PRODUCES a problem, and every construct the
 * helper deliberately permits gets a negative control asserting it does NOT.
 *
 * Fixtures are written whole rather than patched, so no assertion here depends
 * on a string substitution having succeeded.
 */

const TMP = mkdtempSync(join(tmpdir(), 'blocking-gate-'));
let seq = 0;

/** Audit a synthetic workflow's `gate` job. */
function audit(yaml: string) {
  return auditWith(yaml, {});
}

/**
 * The same, with the audit's options — used by the `allowPathsFilter` block.
 *
 * Typed from the REAL options interface rather than re-declaring the option
 * inline (#690): a second `allowPathsFilter?: boolean` declaration is a copied
 * option surface, and the caller scan at the bottom of this file asserts there is
 * exactly one. Reusing the type is also the only version that cannot drift.
 */
function auditWith(
  yaml: string,
  options: Omit<BlockingGateOptions, 'workflowPath' | 'jobId' | 'gateCommand'>,
) {
  const path = join(TMP, `wf-${seq++}.yml`);
  writeFileSync(path, yaml);
  return auditBlockingGate({
    workflowPath: path,
    jobId: 'gate',
    gateCommand: /run-the-gate/,
    ...options,
  });
}

/** Every fixture below is this, plus exactly one edit. */
const CLEAN = `
on:
  pull_request:
jobs:
  gate:
    name: Gate
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        run: run-the-gate
  other:
    name: Other
    runs-on: ubuntu-latest
    steps:
      - name: Something
        run: echo hi
`;

describe('blocking-gate audit engine (#661)', () => {
  describe('the baseline is genuinely clean', () => {
    it('reports no problem, and is non-vacuous about it', () => {
      const a = audit(CLEAN);
      expect(a.problems, a.problems.join('\n')).toEqual([]);
      // Non-vacuity: a helper that parsed nothing would also report nothing.
      expect(a.jobsSeen).toBe(2);
      expect(a.gateStepsSeen).toBe(1);
      expect(a.needsClosure).toEqual(['gate']);
    });
  });

  describe('job-level `if:` — the skip disarm', () => {
    it('detects a plain `if:` key', () => {
      const a = audit(
        CLEAN.replace(
          '    runs-on: ubuntu-latest\n    steps',
          '    if: false\n    runs-on: ubuntu-latest\n    steps',
        ),
      );
      expect(a.problems.join('\n')).toMatch(/job-level `if:`/);
    });

    it('detects a QUOTED `"if":` key — quoting is not a hiding place', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    "if": false
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        run: run-the-gate
`);
      expect(a.problems.join('\n')).toMatch(/job-level `if:`/);
    });

    it('detects a job-level `if:` on a NEEDED job, transitively', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  upstream:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  gate:
    needs: upstream
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        run: run-the-gate
`);
      expect(a.problems.join('\n')).toMatch(/job `upstream` \(needed by gate\).*job-level `if:`/s);
      expect(a.needsClosure).toEqual(expect.arrayContaining(['gate', 'upstream']));
    });
  });

  describe('`continue-on-error` — the unfail disarm', () => {
    it('detects a literal `true` at job level', () => {
      const a = audit(
        CLEAN.replace(
          '    runs-on: ubuntu-latest\n    steps',
          '    continue-on-error: true\n    runs-on: ubuntu-latest\n    steps',
        ),
      );
      expect(a.problems.join('\n')).toMatch(/continue-on-error/);
    });

    it('detects the EXPRESSION form `${{ true }}`, which a literal-true regex misses', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    continue-on-error: \${{ true }}
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        run: run-the-gate
`);
      expect(a.problems.join('\n')).toMatch(/continue-on-error/);
    });

    it('detects it on a STEP, not only on the job', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        continue-on-error: true
        run: run-the-gate
`);
      expect(a.problems.join('\n')).toMatch(/step `Run it` carries continue-on-error/);
    });

    it('detects it on a NON-gate step of the gate job — scanned, not enumerated', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - name: Setup
        continue-on-error: true
        run: echo hi
      - name: Run it
        run: run-the-gate
`);
      expect(a.problems.join('\n')).toMatch(/step `Setup` carries continue-on-error/);
    });

    it('NEGATIVE CONTROL: a literal `false` is permitted', () => {
      const a = audit(
        CLEAN.replace(
          '    runs-on: ubuntu-latest\n    steps',
          '    continue-on-error: false\n    runs-on: ubuntu-latest\n    steps',
        ),
      );
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });
  });

  describe('`needs:` — the indirection disarm', () => {
    it('detects a needed job that does not exist', () => {
      const a = audit(CLEAN.replace('  gate:\n', '  gate:\n    needs: ghost\n'));
      expect(a.problems.join('\n')).toMatch(/job `ghost` \(needed by gate\) is not defined/);
    });

    it('walks an ARRAY of needs, not just a string', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    needs: [ghost-a, ghost-b]
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        run: run-the-gate
`);
      expect(a.problems.join('\n')).toMatch(/`ghost-a`/);
      expect(a.problems.join('\n')).toMatch(/`ghost-b`/);
    });

    it('terminates on a needs CYCLE instead of hanging', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        run: run-the-gate
  a:
    needs: b
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  b:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
      expect(a.needsClosure.sort()).toEqual(['a', 'b', 'gate']);
    });

    it('reports a non-string entry in `needs:`', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    needs: [1]
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        run: run-the-gate
`);
      expect(a.problems.join('\n')).toMatch(/non-string entry in `needs:`/);
    });
  });

  describe('the fail-closed job-key allowlist', () => {
    it('rejects `strategy:` — a matrix expanding to zero jobs runs nothing', () => {
      const a = audit(
        CLEAN.replace('  gate:\n', '  gate:\n    strategy:\n      matrix:\n        n: [1]\n'),
      );
      expect(a.problems.join('\n')).toMatch(/unrecognised job-level key `strategy`/);
    });

    it('rejects `concurrency:` — `cancel-in-progress` can cancel it', () => {
      const a = audit(CLEAN.replace('  gate:\n', '  gate:\n    concurrency: g\n'));
      expect(a.problems.join('\n')).toMatch(/unrecognised job-level key `concurrency`/);
    });

    it('rejects `environment:` — a protection rule can hold or reject it', () => {
      const a = audit(CLEAN.replace('  gate:\n', '  gate:\n    environment: prod\n'));
      expect(a.problems.join('\n')).toMatch(/unrecognised job-level key `environment`/);
    });

    it('rejects `uses:` — a reusable workflow moves the definition out of view', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    uses: ./.github/workflows/other.yml
`);
      expect(a.problems.join('\n')).toMatch(/unrecognised job-level key `uses`/);
    });

    it('rejects a job-level `defaults:` — `shell: bash {0}` drops `-eo pipefail`', () => {
      // Item 3 of the round-2 review. `defaults` was allowlisted as "provably
      // cannot stop the job from running or stop its failure from failing the
      // run". Not true: GitHub's default `bash -eo pipefail {0}` is what makes an
      // intermediate command in a multi-line `run:` fail the step, and
      // `defaults: run: shell: bash {0}` removes it. The allowlist's correctness
      // is the load-bearing design decision here, so a misclassification in the
      // PERMISSIVE direction matters more than one in the strict direction.
      const a = audit(
        CLEAN.replace('  gate:\n', '  gate:\n    defaults:\n      run:\n        shell: bash {0}\n'),
      );
      expect(a.problems.join('\n')).toMatch(/unrecognised job-level key `defaults`/);
    });

    it('rejects an unrecognised key on a NEEDED job too', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  upstream:
    strategy:
      matrix:
        n: [1]
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  gate:
    needs: upstream
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        run: run-the-gate
`);
      expect(a.problems.join('\n')).toMatch(
        /job `upstream` \(needed by gate\).*unrecognised job-level key `strategy`/s,
      );
    });

    it('NEGATIVE CONTROL: `timeout-minutes:` is permitted', () => {
      const a = audit(CLEAN.replace('  gate:\n', '  gate:\n    timeout-minutes: 30\n'));
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });

    it('NEGATIVE CONTROL: `env:` and `permissions:` are permitted', () => {
      const a = audit(
        CLEAN.replace(
          '  gate:\n',
          '  gate:\n    env:\n      FOO: bar\n    permissions:\n      contents: read\n',
        ),
      );
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });
  });

  describe('the gate step itself', () => {
    it('detects a step-level `if:` on the step the job exists to run', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - name: Run it
        if: \${{ github.event_name == 'push' }}
        run: run-the-gate
`);
      expect(a.problems.join('\n')).toMatch(/the gate step `Run it` carries an `if:`/);
    });

    it('NEGATIVE CONTROL: an `if:` on a NON-gate step is legitimate', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - name: Optional setup
        if: \${{ runner.os == 'Linux' }}
        run: echo hi
      - name: Run it
        run: run-the-gate
`);
      expect(a.problems, a.problems.join('\n')).toEqual([]);
      expect(a.gateStepsSeen).toBe(1);
    });

    it('reports a job with no `steps:` list at all', () => {
      const a = audit(`
on:
  pull_request:
jobs:
  gate:
    runs-on: ubuntu-latest
`);
      expect(a.problems.join('\n')).toMatch(/has no `steps:` list/);
    });
  });

  describe('the trigger half', () => {
    it('detects a workflow that does not trigger on `pull_request` at all', () => {
      const a = audit(CLEAN.replace('  pull_request:\n', '  push:\n    branches: [main]\n'));
      expect(a.problems.join('\n')).toMatch(/does not trigger on `pull_request`/);
    });

    it('detects a `paths:` filter', () => {
      const a = audit(
        CLEAN.replace('  pull_request:\n', "  pull_request:\n    paths: ['src/**']\n"),
      );
      expect(a.problems.join('\n')).toMatch(/`paths` filter/);
    });

    it('detects a `paths-ignore:` filter', () => {
      const a = audit(
        CLEAN.replace('  pull_request:\n', "  pull_request:\n    paths-ignore: ['docs/**']\n"),
      );
      expect(a.problems.join('\n')).toMatch(/`paths-ignore` filter/);
    });

    // --- Round-2 review item 1: the three filters that were NOT audited. ---

    it("detects `branches: ['*']` — `*` does not match `/`, so a stacked PR never runs it", () => {
      // NOT hypothetical. This is `ci.yml`'s live value, and PR #583 (base
      // `chore/gitignore-agent-artifacts`) ran ZERO `ci.yml` jobs because of it:
      // no `Lint & Test`, no `bun-exec-hardcap`, no `bun-exec-alpine-image`.
      // Stacked PRs are this repo's normal mode, so this is the common case.
      const a = audit(CLEAN.replace('  pull_request:\n', "  pull_request:\n    branches: ['*']\n"));
      expect(a.problems.join('\n')).toMatch(/`branches` filter/);
    });

    it('detects a named `branches:` allowlist', () => {
      const a = audit(
        CLEAN.replace('  pull_request:\n', '  pull_request:\n    branches: [main]\n'),
      );
      expect(a.problems.join('\n')).toMatch(/`branches` filter/);
    });

    it('detects `branches-ignore:`, which has no universal form', () => {
      const a = audit(
        CLEAN.replace('  pull_request:\n', "  pull_request:\n    branches-ignore: ['**']\n"),
      );
      expect(a.problems.join('\n')).toMatch(/`branches-ignore`/);
    });

    it('detects a `types:` filter — the default set is not the whole set', () => {
      const a = audit(
        CLEAN.replace('  pull_request:\n', '  pull_request:\n    types: [labeled]\n'),
      );
      expect(a.problems.join('\n')).toMatch(/`types`/);
    });

    it('fails closed on an unrecognised `pull_request` key', () => {
      const a = audit(
        CLEAN.replace('  pull_request:\n', '  pull_request:\n    some-future-filter: [x]\n'),
      );
      expect(a.problems.join('\n')).toMatch(/some-future-filter/);
    });

    it("NEGATIVE CONTROL: `branches: ['**']` is universal, so it is permitted", () => {
      // `**` matches every branch name including slashes, so it is provably
      // equivalent to omitting the filter. This is already the in-repo idiom —
      // `install-smoke.yml` uses it, which is why that workflow DID run on #583.
      const a = audit(
        CLEAN.replace('  pull_request:\n', "  pull_request:\n    branches: ['**']\n"),
      );
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });

    it('NEGATIVE CONTROL: a bare `pull_request:` with no filters is permitted', () => {
      expect(audit(CLEAN).problems).toEqual([]);
    });
  });

  /**
   * `allowPathsFilter` — the ONE filter a caller may opt into (#677).
   *
   * A deliberately `paths:`-scoped gate is a real category:
   * `image-pin-resolution-nightly.yml` puts a third-party registry call behind
   * the diffs that can actually introduce a pin, precisely so every other merge
   * does not depend on Docker Hub. Without this option that guard could not use
   * the audit at all, and it stayed on the evadable TEXT form for two rounds
   * because of it.
   *
   * The option is narrow BY TEST, not by comment: it exempts `paths` and nothing
   * else, it rejects an EMPTY `paths` list (an allowlist matching nothing is a
   * gate that never runs — strictly more than the un-optioned audit checks), and
   * it touches only the trigger half.
   */
  describe('`allowPathsFilter` — an opt-in for a deliberately paths-scoped gate (#677)', () => {
    // `tests/**`, not `src/**`: since #690 the audit refuses a filter that
    // matches NO tracked file, and this repo has no top-level `src/`. A fixture
    // glob that matches nothing would be testing the vacuity rule by accident.
    const PATHS = "  pull_request:\n    paths: ['tests/**']\n";

    it('permits the `paths:` filter, and REPORTS what it permitted', () => {
      const a = auditWith(CLEAN.replace('  pull_request:\n', PATHS), { allowPathsFilter: true });
      expect(a.problems, a.problems.join('\n')).toEqual([]);
      // Non-vacuity: the caller must be able to assert the filter's CONTENTS
      // cover what the gate protects, so the audit hands them back.
      expect(a.pullRequestPaths).toEqual(['tests/**']);
    });

    it('is OFF by default — the same workflow still reports the filter', () => {
      const a = audit(CLEAN.replace('  pull_request:\n', PATHS));
      expect(a.problems.join('\n')).toMatch(/`paths` filter/);
    });

    it('rejects an EMPTY `paths:` list — an allowlist matching nothing never runs', () => {
      const a = auditWith(CLEAN.replace('  pull_request:\n', '  pull_request:\n    paths: []\n'), {
        allowPathsFilter: true,
      });
      expect(a.problems.join('\n')).toMatch(/`paths` filter is empty/);
    });

    it('does NOT extend to `paths-ignore:` — an exclusion is not the same claim', () => {
      const a = auditWith(
        CLEAN.replace('  pull_request:\n', "  pull_request:\n    paths-ignore: ['docs/**']\n"),
        { allowPathsFilter: true },
      );
      expect(a.problems.join('\n')).toMatch(/`paths-ignore` filter/);
    });

    it('does NOT launder a `branches:` filter riding in beside the `paths:` one', () => {
      const a = auditWith(CLEAN.replace('  pull_request:\n', `${PATHS}    branches: [main]\n`), {
        allowPathsFilter: true,
      });
      expect(a.problems.join('\n')).toMatch(/`branches` filter/);
    });

    it('does NOT touch the job half: a job-level `if:` still reds', () => {
      const a = auditWith(
        CLEAN.replace('  pull_request:\n', PATHS).replace(
          '    name: Gate\n',
          '    name: Gate\n    if: false\n',
        ),
        { allowPathsFilter: true },
      );
      expect(a.problems.join('\n')).toMatch(/job-level `if:`/);
    });

    it('reports no paths for a workflow that has none, whatever the option says', () => {
      expect(auditWith(CLEAN, { allowPathsFilter: true }).pullRequestPaths).toEqual([]);
    });

    /**
     * A VACUOUS filter is refused by the AUDIT, not left to the caller (#690).
     *
     * Round 1 checked `value.length === 0` and stopped, so three filters that
     * match nothing walked through — and the only thing standing between them
     * and a permanently-skipped gate was a caller obligation written in prose.
     * Each forbidden shape below is exercised in TWO spellings, because the
     * finding that produced this block is precisely that one spelling is not a
     * rule.
     */
    const withPaths = (paths: string) =>
      CLEAN.replace('  pull_request:\n', `  pull_request:\n    paths: ${paths}\n`);
    const auditPaths = (paths: string) =>
      auditWith(withPaths(paths), { allowPathsFilter: true }).problems.join('\n');

    it('rejects an EMPTY-STRING glob, in both quoting styles', () => {
      expect(auditPaths("['']")).toMatch(/vacuous entry/);
      expect(auditPaths('[""]')).toMatch(/vacuous entry/);
    });

    it('rejects a WHITESPACE-ONLY glob, spaces or a tab', () => {
      expect(auditPaths("['   ']")).toMatch(/vacuous entry/);
      expect(auditPaths('["\\t"]')).toMatch(/vacuous entry/);
    });

    it('rejects a NON-STRING entry — `null` and a number', () => {
      expect(auditPaths('[null]')).toMatch(/vacuous entry/);
      expect(auditPaths('[42]')).toMatch(/vacuous entry/);
    });

    it('THE CASE THAT MATTERS: a list matching NO tracked file, two spellings', () => {
      expect(auditPaths("['no/such/dir/**']")).toMatch(/matches NO tracked file/);
      expect(auditPaths("['nowhere/*.zzz', 'also-nowhere/**/*.qqq']")).toMatch(
        /matches NO tracked file/,
      );
    });

    it('a padded but REAL glob is not vacuous — trimmed before matching', () => {
      expect(auditWith(withPaths("['  tests/** ']"), { allowPathsFilter: true }).problems).toEqual(
        [],
      );
    });

    it('NEGATIVE CONTROL: a filter that matches tracked files is permitted', () => {
      expect(auditWith(withPaths("['tests/**']"), { allowPathsFilter: true }).problems).toEqual([]);
    });

    it('the rule is LIST-level, not per-glob — future scope the walk accepts stays legal', () => {
      // MEASURED as the reason the per-glob form was rejected: the real gate
      // pins `benchmarks/**/*.yml`, which matches no tracked file today while
      // `verify-image-pins.mjs` would scan such a file the moment one exists.
      // A per-glob rule would make deleting a CORRECT glob the way back to
      // green, which is the "edit the guard" failure security.md names.
      expect(
        auditWith(withPaths("['tests/**', 'benchmarks/**/*.yml']"), { allowPathsFilter: true })
          .problems,
      ).toEqual([]);
    });
  });

  describe('workflow-level concurrency (#674)', () => {
    // A JOB-level `concurrency` is already reported by the fail-closed
    // allowlist. The WORKFLOW-level one was invisible to this audit, and #674
    // adds exactly such a block to `ci.yml` — where two audited gates live. So
    // the question the audit now has to answer is not "is there a group" but
    // "can anything OTHER than a superseding push to this same ref cancel the
    // gate". A ref-scoped group cannot: the only canceller is a newer commit on
    // the same PR, whose own run must go green on the new head SHA. A group that
    // is NOT ref-scoped can be tripped by an unrelated ref, and that is a
    // genuine disarm.
    const withWorkflowConcurrency = (block: string) => `${block}${CLEAN}`;

    it('reports a cancelling workflow-level group that is not ref-scoped', () => {
      const a = audit(
        withWorkflowConcurrency('concurrency:\n  group: ci\n  cancel-in-progress: true\n'),
      );
      expect(a.problems.join('\n')).toMatch(/concurrency/);
      expect(a.problems.join('\n')).toMatch(/cancel/i);
    });

    it('reports a cancelling group keyed on something other than the ref', () => {
      // `github.workflow` alone is constant across every ref, so this is the
      // fixed-string case wearing an expression.
      const a = audit(
        withWorkflowConcurrency(
          'concurrency:\n  group: ${{ github.workflow }}\n  cancel-in-progress: true\n',
        ),
      );
      expect(a.problems.join('\n')).toMatch(/concurrency/);
    });

    it('treats a non-literal `cancel-in-progress` as cancelling', () => {
      // Same class as `continue-on-error: ${{ true }}` — an expression is not
      // the literal `false`, so it is not a reason to wave the group through.
      const a = audit(
        withWorkflowConcurrency('concurrency:\n  group: ci\n  cancel-in-progress: ${{ true }}\n'),
      );
      expect(a.problems.join('\n')).toMatch(/concurrency/);
    });

    it('rejects an interpolation that merely CONTAINS `github.ref` as a substring', () => {
      // Round 1's `REF_SCOPED` was `/\$\{\{[^}]*github\.(ref|ref_name|head_ref)[^}]*\}\}/`,
      // so any expression with `github.ref` ANYWHERE in it was accepted.
      // `github.ref_protected` is a boolean — two possible values across the
      // whole repository — so this group collapses every PR into one of two
      // buckets, which is exactly the cross-PR disarm this check exists to
      // reject, in a check documented as failing closed.
      const a = audit(
        withWorkflowConcurrency(
          'concurrency:\n  group: ci-${{ github.ref_protected }}\n  cancel-in-progress: true\n',
        ),
      );
      expect(a.problems.join('\n')).toMatch(/concurrency/);
    });

    it('rejects a COMPARISON on `github.ref`, which is a boolean, not a ref', () => {
      // `${{ github.ref == 'refs/heads/main' }}` renders `true` or `false`. Same
      // collapse, and it reads even more like ref scoping than the last one.
      const a = audit(
        withWorkflowConcurrency(
          "concurrency:\n  group: ci-${{ github.ref == 'refs/heads/main' }}\n  cancel-in-progress: true\n",
        ),
      );
      expect(a.problems.join('\n')).toMatch(/concurrency/);
    });

    it('rejects the bare literal `pull_request.number` with no interpolation', () => {
      // Round 1's second alternation was unanchored, so the FIXED STRING
      // `pull_request.number` — no `${{ }}` at all, therefore identical for
      // every PR — was accepted as PR scoping. A literal cannot scope anything.
      const a = audit(
        withWorkflowConcurrency(
          'concurrency:\n  group: pull_request.number\n  cancel-in-progress: true\n',
        ),
      );
      expect(a.problems.join('\n')).toMatch(/concurrency/);
    });

    it('NEGATIVE CONTROL: a real PR-number interpolation is still accepted', () => {
      // The form the round-1 alternation was presumably reaching for. It varies
      // per pull request, so it scopes.
      const a = audit(
        withWorkflowConcurrency(
          'concurrency:\n  group: preview-${{ github.event.pull_request.number }}\n  cancel-in-progress: true\n',
        ),
      );
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });

    it('NEGATIVE CONTROL: `github.head_ref` and `github.ref_name` still scope', () => {
      // `head_ref` is accepted DELIBERATELY, not by omission, and it is the
      // weaker of the two: it is a bare branch name, so two pull requests from
      // different FORKS both on `patch-1` share a group and one can cancel the
      // other's gate. The decision to accept it anyway — what was measured, and
      // what would reopen it — is recorded next to `PER_PR_CONTEXTS` in
      // `tests/helpers/blocking-gate.ts` (#679). Flipping this expectation is a
      // decision, not a fix.
      for (const key of ['github.head_ref', 'github.ref_name']) {
        const a = audit(
          withWorkflowConcurrency(
            `concurrency:\n  group: ci-\${{ ${key} }}\n  cancel-in-progress: true\n`,
          ),
        );
        expect(a.problems, `${key}: ${a.problems.join('\n')}`).toEqual([]);
      }
    });

    it('NEGATIVE CONTROL: an `||` fallback chain of per-PR contexts still scopes', () => {
      // The round-2 tightening ("the body must be EXACTLY one context") was a
      // COVERAGE REGRESSION on the canonical GitHub idiom, measured: both of
      // these render a per-PR value and both were rejected, with a message
      // saying "not scoped to the ref" that is FALSE for them. `||` here is
      // OPERAND FALLBACK — the expression's value IS one of its operands — which
      // is the opposite of the `==` case the tightening exists to reject, where
      // the value is a boolean that is not any operand.
      for (const body of [
        'github.head_ref || github.ref',
        'github.event.pull_request.number || github.ref',
        'github.head_ref || github.ref_name || github.ref',
      ]) {
        const a = audit(
          withWorkflowConcurrency(
            `concurrency:\n  group: ci-\${{ ${body} }}\n  cancel-in-progress: true\n`,
          ),
        );
        expect(a.problems, `${body}: ${a.problems.join('\n')}`).toEqual([]);
      }
    });

    it('rejects an `&&` chain — its value is only the LAST operand (#679)', () => {
      // The counterpart to the `||` negative control above, and the reason
      // `bodyIsPerPr` splits on `||` ONLY.
      //
      // `a && b` in a GitHub expression evaluates to `b` when `a` is truthy and
      // to `a` (the falsy value) otherwise — so unlike `||`, "every operand
      // varies per PR" does NOT imply the RESULT varies per PR, and the operand
      // that decides the group is the last one. Splitting on `&&` was MEASURED
      // to flip the first body below from rejected to ACCEPTED, i.e. it would
      // admit a group whose per-PR-ness had never been established.
      //
      // Without this case the `&&` omission looks like an inconsistency next to
      // the `||` split, and "fixing" it would widen the rule silently. Now it
      // reds.
      for (const body of [
        'github.head_ref && github.ref',
        'github.event.pull_request.number && github.event.inputs.env',
      ]) {
        const a = audit(
          withWorkflowConcurrency(
            `concurrency:\n  group: ci-\${{ ${body} }}\n  cancel-in-progress: true\n`,
          ),
        );
        expect(a.problems.join('\n'), body).toMatch(/concurrency/);
      }
    });

    it('rejects an `||` chain with an EMPTY operand', () => {
      // Pins the behaviour an explicit empty-operand guard used to state
      // redundantly (#679 item 4): an empty operand is in neither admissible
      // set, so the chain fails on its own terms. Removing that guard changed
      // no outcome — this keeps the outcome asserted rather than inferred.
      const a = audit(
        withWorkflowConcurrency(
          'concurrency:\n  group: ci-${{ github.ref || }}\n  cancel-in-progress: true\n',
        ),
      );
      expect(a.problems.join('\n')).toMatch(/concurrency/);
    });

    it("NEGATIVE CONTROL: `preview.yml`'s real group is accepted", () => {
      // `.github/workflows/preview.yml:47` already uses this shape. It does not
      // red today only because `preview.yml` carries no audited gate; when one
      // lands, a guard that rejects a correct group is how "edit the guard"
      // becomes the routine fix. A `workflow_dispatch` input is accepted as a
      // FALLBACK operand only — see the sole-operand rejection below.
      const a = audit(
        withWorkflowConcurrency(
          'concurrency:\n  group: preview-${{ github.event.pull_request.number || github.event.inputs.pr }}\n  cancel-in-progress: true\n',
        ),
      );
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });

    it('rejects a dispatch input as the SOLE operand — it need not vary per PR', () => {
      // The permissive direction is the one that matters. `github.event.inputs.*`
      // is an arbitrary user-supplied string; on its own it can be a constant
      // (`environment`, a default value), which collapses every ref into one
      // group. It is admissible only behind a real per-PR operand.
      for (const body of [
        'github.event.inputs.env',
        'github.event.inputs.a || github.event.inputs.b',
      ]) {
        const a = audit(
          withWorkflowConcurrency(
            `concurrency:\n  group: ci-\${{ ${body} }}\n  cancel-in-progress: true\n`,
          ),
        );
        expect(a.problems.join('\n'), body).toMatch(/concurrency/);
      }
    });

    it('accepts a dispatch input in FIRST position — position is not the rule (#679)', () => {
      // The claim `DISPATCH_INPUT`'s comment used to make ("admissible only as a
      // LATER operand, never alone") was not what the code does: the rule is a
      // COUNT over the operand set — every operand admissible, at least one
      // genuinely per-PR — and a count has no order. This pins the actual
      // behaviour so the comment and the code cannot drift apart again.
      const a = audit(
        withWorkflowConcurrency(
          'concurrency:\n  group: ci-${{ github.event.inputs.env || github.ref }}\n  cancel-in-progress: true\n',
        ),
      );
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });

    it('rejects an `||` chain containing a non-per-PR operand', () => {
      // Fail closed on the chain as a whole: `github.ref_protected` is still a
      // boolean, and admitting a chain because ONE operand is fine would let the
      // rejected forms back in through the fallback slot.
      const a = audit(
        withWorkflowConcurrency(
          'concurrency:\n  group: ci-${{ github.ref_protected || github.workflow }}\n  cancel-in-progress: true\n',
        ),
      );
      expect(a.problems.join('\n')).toMatch(/concurrency/);
    });

    it('the rejection message states what IS accepted, not a claim about the ref', () => {
      // "not scoped to the ref" was false for the `||` forms above, and a guard
      // whose message misdescribes the defect trains readers to edit the guard.
      const a = audit(
        withWorkflowConcurrency('concurrency:\n  group: ci\n  cancel-in-progress: true\n'),
      );
      expect(a.problems.join('\n')).toMatch(/github\.event\.pull_request\.number/);
      expect(a.problems.join('\n')).toMatch(/github\.head_ref/);
    });

    it('NEGATIVE CONTROL: a ref-scoped cancelling group is permitted', () => {
      const a = audit(
        withWorkflowConcurrency(
          'concurrency:\n  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}\n  cancel-in-progress: true\n',
        ),
      );
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });

    it('NEGATIVE CONTROL: a non-cancelling group needs no ref scope', () => {
      const a = audit(
        withWorkflowConcurrency('concurrency:\n  group: ci\n  cancel-in-progress: false\n'),
      );
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });

    it('NEGATIVE CONTROL: the shorthand string form queues, it does not cancel', () => {
      const a = audit(withWorkflowConcurrency('concurrency: ci\n'));
      expect(a.problems, a.problems.join('\n')).toEqual([]);
    });
  });

  describe('structural non-vacuity', () => {
    it('fails a workflow with no `jobs:` mapping rather than passing by absence', () => {
      const a = audit('on:\n  pull_request:\n');
      expect(a.problems.join('\n')).toMatch(/has no `jobs:` mapping/);
      expect(a.jobsSeen).toBe(0);
    });

    it('reports a gate job that is not defined at all', () => {
      const a = audit(CLEAN.replace('  gate:\n', '  not-the-gate:\n'));
      expect(a.problems.join('\n')).toMatch(/job `gate` is not defined/);
    });

    it('reports zero gate steps when nothing matches `gateCommand`', () => {
      const a = audit(
        CLEAN.replace('        run: run-the-gate\n', '        run: something-else\n'),
      );
      expect(a.gateStepsSeen).toBe(0);
    });
  });
});

/**
 * `allowPathsFilter`'s remaining caller obligation — scanned, and fail-closed (#690 r2).
 *
 * WHAT THE AUDIT NOW OWNS. Round 1 left the whole "is this filter real" question
 * to the caller, enforced by a scan for one forbidden SPELLING (`.toBeGreaterThan`).
 * That was a blocklist, and a blocklist of one token is a one-token bypass:
 * `expect(a.pullRequestPaths.length).toEqual(TRIGGER_PATHS.length)` satisfied it
 * while `paths: ['','','','','','']` satisfies THAT. The fix is not a longer
 * pattern — it is to shrink the obligation: `vacuousPathsProblems` in
 * `blocking-gate.ts` now refuses empty, blank, non-string and match-nothing
 * filters at the audit, fail-closed, where no caller spelling can evade it.
 *
 * WHAT IS LEFT FOR THE CALLER, and why this scan still exists: COVERAGE. Only the
 * caller knows what its gate protects, so only the caller can say the filter
 * reaches all of it. This scan is the backstop that every opt-in caller states
 * that claim as a PIN — not the sole line of defence it was in round 1.
 *
 * AN ALLOWLIST, NOT A BLOCKLIST. A compliant pin is
 * `expect(<subject>).toEqual|toStrictEqual(<literal string array>)`, where the
 * subject reaches `pullRequestPaths` (directly or through an alias) and is not a
 * `.length` of it, and the expected value is a literal array of string literals —
 * inline, or an identifier bound to one in the same file. Every other spelling
 * FAILS, including ones nobody enumerated: `toHaveLength(6)`,
 * `toEqual(expect.any(Array))`, `toEqual(pr?.paths)` (self-derived from the same
 * workflow the audit just read, so it can agree with anything), and
 * `.length).toEqual(n)`. That is the shape this repo asks for — an unrecognised
 * construct fails rather than passes.
 *
 * SCANNED, never enumerated. The corpus is every tracked file whose extension is
 * a JS/TS one (`.ts .tsx .cts .mts .js .jsx .cjs .mjs` — derived from a regex, so
 * `.cts` is covered without anyone adding it; five tracked `.cjs` files were
 * invisible to round 1's hand-listed globs). The view is `codeWithLiterals`:
 * comments blanked so a commented-out pin satisfies nothing, literals INTACT so a
 * quoted key (`{ ['allowPathsFilter']: true }`) cannot hide from either half.
 *
 * HONEST ABOUT ITS GRAIN: per-FILE, not per-call-site. Statically pairing one
 * `auditBlockingGate({ allowPathsFilter: true })` with the assertion that pins ITS
 * result is not tractable here, and a check that guessed would be edited rather
 * than obeyed. A file that opts in and pins nothing is caught; a file that opts in
 * twice and pins once is not.
 */
describe('#690 every `allowPathsFilter` caller pins the filter CONTENTS', () => {
  const REPO_ROOT = resolve(import.meta.dirname, '..');

  /** The ONE file that declares the option, exempt because it defines it. */
  const OPTION_DEFINITION_FILE = 'tests/helpers/blocking-gate.ts';

  /** `allowPathsFilter?: boolean` — the declaration, not a use of it. */
  const DECLARES_OPTION = /\ballowPathsFilter\s*\?\s*:/;

  /**
   * Any code mention at all. Deliberately NOT `allowPathsFilter:\s*true`: a
   * caller can pass `allowPathsFilter: flag`, spread it in from an object, or
   * build the options elsewhere, and a pattern that only saw the literal form
   * would wave all three through. Fail closed on the identifier.
   */
  const MENTIONS_OPTION = /\ballowPathsFilter\b/;

  /**
   * The same option written as a QUOTED KEY — `{ 'allowPathsFilter': true }` or
   * `{ ['allowPathsFilter']: true }`, and the quoted form of the declaration.
   *
   * Read from the literals-intact view, which the identifier patterns above are
   * NOT: under `blankNonCode` a quoted key is emptied and escapes both halves,
   * but reading every literal as code would claim any file that merely NAMES the
   * option in an assertion message — a false positive is how a scan trains people
   * to edit the guard. A quoted key is followed by `:` (optionally through a
   * closing `]`), which prose never is.
   */
  const QUOTED_OPTION_KEY = /(['"])allowPathsFilter\1\s*\]?\s*\??\s*:/;

  /** The quoted form of the DECLARATION specifically — `'allowPathsFilter'?: boolean`. */
  const QUOTED_DECLARATION = /(['"])allowPathsFilter\1\s*\?\s*:/;

  /** The corpus: every tracked JS/TS-family file, by extension rather than by list. */
  const JS_TS_FILE = /\.(?:[cm]?[jt]sx?)$/;

  /** The two matchers that compare CONTENTS. Everything else is not a pin. */
  const CONTENTS_MATCHERS = new Set(['toEqual', 'toStrictEqual']);

  /** `['a', "b"]` and nothing else — a non-empty literal array of string literals. */
  const LITERAL_STRING_ARRAY =
    /^\[\s*(?:(['"])(?:\\.|(?!\1)[^\\])*\1\s*,\s*)*(['"])(?:\\.|(?!\2)[^\\])*\2\s*,?\s*\]$/;

  type SourceFile = { path: string; source: string };

  /** The `[start, end)` of the argument list opened at `open` (a `(` or `[`). */
  function balanced(code: string, open: number): [number, number] | null {
    const pairs: Record<string, string> = { '(': ')', '[': ']' };
    const close = pairs[code[open] as string];
    if (!close) return null;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      const c = code[i] as string;
      if (c === '(' || c === '[') depth += 1;
      else if (c === ')' || c === ']') {
        depth -= 1;
        if (depth === 0) return [open + 1, i];
      }
    }
    return null;
  }

  /**
   * Does this file contain at least one COMPLIANT pin?
   *
   * Structural rather than one regex: `expect(<subject>)` is read with balanced
   * parens, the matcher that follows is read by name, and its argument is read the
   * same way. A regex over the whole construct is what let `.length).toEqual(` in,
   * because `[^;]*?\)` happily stopped at the wrong paren.
   */
  function hasCompliantPin(code: string): boolean {
    // Aliases, both spellings: `const p = <expr mentioning pullRequestPaths>` and
    // the destructuring rename `const { pullRequestPaths: got } = audit`. A guard
    // that reds on a correct alias is how "edit the guard" becomes the way back to
    // green, so the value is followed rather than the spelling policed.
    const aliases = [
      ...[...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)]
        .filter((m) => /\bpullRequestPaths\b/.test(m[2] as string))
        .map((m) => m[1] as string),
      ...[...code.matchAll(/\bpullRequestPaths\s*:\s*([A-Za-z_$][\w$]*)/g)].map(
        (m) => m[1] as string,
      ),
    ];
    const subjectRe = new RegExp(
      `\\b(?:pullRequestPaths${aliases.map((a) => `|${a}`).join('')})\\b`,
    );

    // Identifiers bound to a literal string array, for `toEqual(TRIGGER_PATHS)`.
    //
    // SAME-FILE ONLY, and that is a KNOWN FALSE POSITIVE, not an oversight: a pin
    // whose list is IMPORTED from another module reds here, even though sharing
    // `TRIGGER_PATHS` between the workflow spec and the gate spec is the natural
    // refactor. Resolving imports would mean parsing the module graph from a
    // regex scan. The cost is real — a false red is exactly the pressure that
    // makes editing the guard the way back to green — so if someone hits it,
    // widen this by resolving the import, do NOT relax the pin form.
    const literalArrayConsts = new Set(
      [
        ...code.matchAll(
          /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(\[[^;]*?\])\s*(?:as\s+const\s*)?;/g,
        ),
      ]
        .filter((m) => LITERAL_STRING_ARRAY.test((m[2] as string).replace(/\s+/g, ' ').trim()))
        .map((m) => m[1] as string),
    );

    for (const m of code.matchAll(/\bexpect\s*\(/g)) {
      const open = (m.index as number) + m[0].length - 1;
      const span = balanced(code, open);
      if (!span) continue;
      const subject = code.slice(span[0], span[1]);
      if (!subjectRe.test(subject)) continue;
      // `expect(a.pullRequestPaths.length)` is a LENGTH assertion whatever matcher
      // follows it — the round-1 bypass, in every spelling at once.
      if (/\.\s*length\b/.test(subject)) continue;
      const after = code.slice(span[1] + 1);
      const call = after.match(/^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/);
      if (!call) continue;
      if (!CONTENTS_MATCHERS.has(call[1] as string)) continue;
      const argOpen = span[1] + 1 + (call[0].length - 1) + (call.index as number);
      const argSpan = balanced(code, argOpen);
      if (!argSpan) continue;
      const expected = code.slice(argSpan[0], argSpan[1]).replace(/\s+/g, ' ').trim();
      if (LITERAL_STRING_ARRAY.test(expected)) return true;
      if (/^[A-Za-z_$][\w$]*$/.test(expected) && literalArrayConsts.has(expected)) return true;
      // Anything else — `expect.any(Array)`, `pr?.paths`, a call, a spread — is
      // not a pin. Self-derived expectations are the point: a value read from the
      // same workflow the audit just parsed agrees with whatever is there.
    }
    return false;
  }

  /**
   * Classify a corpus.
   *
   * TWO VIEWS, for two different questions. `blanked` (comments AND literal
   * contents emptied) answers "is the identifier used in code", so an assertion
   * message that merely names the option is not a caller. `code` (comments
   * blanked, literals intact) answers "is there a quoted key" and "is there a
   * literal-array pin", both of which live inside literals by construction.
   */
  function auditAllowPathsCallers(files: SourceFile[]) {
    const definers: string[] = [];
    const callers: string[] = [];
    const findings: string[] = [];
    for (const { path, source } of files) {
      const code = codeWithLiterals(source);
      const blanked = blankNonCode(source);
      if (DECLARES_OPTION.test(blanked) || QUOTED_DECLARATION.test(code)) definers.push(path);
      if (
        path === OPTION_DEFINITION_FILE ||
        !(MENTIONS_OPTION.test(blanked) || QUOTED_OPTION_KEY.test(code))
      ) {
        continue;
      }
      callers.push(path);
      if (!hasCompliantPin(code)) {
        findings.push(
          `${path} passes \`allowPathsFilter\` but carries no CONTENTS pin of \`pullRequestPaths\` — required form: expect(<…pullRequestPaths>).toEqual([<string literals>]) or .toEqual(<const bound to one>). A \`.length\` subject, a \`toHaveLength\`, an \`expect.any(...)\`, or a value derived from the same workflow are all NOT pins: only the caller can state that the filter COVERS what its gate protects`,
        );
      }
    }
    return { definers, callers, findings };
  }

  const trackedSources = (): SourceFile[] =>
    execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\0')
      .filter((p) => p && JS_TS_FILE.test(p))
      .map((path) => ({ path, source: readFileSync(resolve(REPO_ROOT, path), 'utf8') }));

  const pinFinding = (source: string, path = 'tests/synthetic.test.ts') =>
    auditAllowPathsCallers([{ path, source }]).findings.join(' ');

  const OPTS = 'const a = auditBlockingGate({ allowPathsFilter: true });\n';

  it('the corpus is real and every caller in it pins the contents', () => {
    const files = trackedSources();
    // Non-vacuity, twice: an empty corpus, or a corpus with no caller in it,
    // would make the findings assertion pass by having nothing to check.
    expect(files.length, 'git ls-files returned nothing — the scan is vacuous').toBeGreaterThan(20);
    const { callers, findings } = auditAllowPathsCallers(files);
    expect(
      callers,
      'no caller found — either the option is gone or the scan is broken',
    ).not.toEqual([]);
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('the corpus reaches every JS/TS extension, `.cjs` included', () => {
    // Round 1 hand-listed `*.ts *.tsx *.mts *.mjs *.js`, so five tracked `.cjs`
    // files were invisible: a `.cjs` caller scanned GREEN while the byte-identical
    // file named `.js` red. Derived from the extension regex now, so `.cts` and
    // `.jsx` come along without anyone remembering them.
    for (const ext of ['ts', 'tsx', 'cts', 'mts', 'js', 'jsx', 'cjs', 'mjs']) {
      expect(JS_TS_FILE.test(`tests/x.${ext}`), `.${ext} must be in the corpus`).toBe(true);
    }
    expect(JS_TS_FILE.test('tests/x.json')).toBe(false);
    // And the real corpus contains a `.cjs`, so the claim is measured, not assumed.
    const exts = new Set(trackedSources().map((f) => f.path.replace(/^.*\./, '')));
    expect([...exts].some((e) => e === 'cjs' || e === 'mjs')).toBe(true);
  });

  it('exactly ONE tracked file declares the option, and it is the exempt one', () => {
    // The exemption above is path-anchored, and it is only sound while the
    // declaration is unique: a second declaration is a copied option surface,
    // and the copy would inherit the exemption for free.
    const { definers } = auditAllowPathsCallers(trackedSources());
    expect(definers, `allowPathsFilter is declared in: ${definers.join(', ')}`).toEqual([
      OPTION_DEFINITION_FILE,
    ]);
  });

  it('THE CASE THAT MATTERS: a new caller that pins nothing IS a finding', () => {
    expect(pinFinding(OPTS, 'tests/a-second-caller.test.ts')).toMatch(/a-second-caller/);
  });

  it('a LENGTH subject is not a pin — in BOTH the round-1 and the bypass spelling', () => {
    // The measured round-2 finding: the first spelling was the only one the
    // round-1 regex refused, and the second walked straight through it while
    // `paths: ['','','','','','']` satisfies the assertion itself.
    expect(pinFinding(`${OPTS}expect(a.pullRequestPaths.length).toBeGreaterThan(0);`)).toMatch(
      /no CONTENTS pin/,
    );
    expect(
      pinFinding(`${OPTS}expect(a.pullRequestPaths.length).toEqual(TRIGGER_PATHS.length);`),
    ).toMatch(/no CONTENTS pin/);
  });

  it('a LENGTH matcher is not a pin either — `toHaveLength`, two arities', () => {
    expect(pinFinding(`${OPTS}expect(a.pullRequestPaths).toHaveLength(6);`)).toMatch(
      /no CONTENTS pin/,
    );
    expect(pinFinding(`${OPTS}expect(a.pullRequestPaths).toHaveLength(SIX);`)).toMatch(
      /no CONTENTS pin/,
    );
  });

  it('an ASYMMETRIC matcher is not a pin — `expect.any` and `expect.arrayContaining`', () => {
    expect(pinFinding(`${OPTS}expect(a.pullRequestPaths).toEqual(expect.any(Array));`)).toMatch(
      /no CONTENTS pin/,
    );
    expect(
      pinFinding(`${OPTS}expect(a.pullRequestPaths).toEqual(expect.arrayContaining(['x']));`),
    ).toMatch(/no CONTENTS pin/);
  });

  it('a SELF-DERIVED expectation is not a pin — the audit cannot check itself', () => {
    // `toEqual(pr?.paths)` compares the audit against the same workflow the audit
    // just parsed, so it holds for `['']` exactly as well as for the real globs.
    expect(pinFinding(`${OPTS}expect(a.pullRequestPaths).toEqual(pr?.paths);`)).toMatch(
      /no CONTENTS pin/,
    );
    expect(
      pinFinding(
        `${OPTS}expect(a.pullRequestPaths).toEqual(parseWorkflow().on.pull_request.paths);`,
      ),
    ).toMatch(/no CONTENTS pin/);
  });

  it('an EMPTY literal array is not a pin — it asserts the gate has no filter', () => {
    expect(pinFinding(`${OPTS}expect(a.pullRequestPaths).toEqual([]);`)).toMatch(/no CONTENTS pin/);
  });

  it('NEGATIVE CONTROL: an inline literal pin is clean, in both quoting styles', () => {
    expect(pinFinding(`${OPTS}expect(a.pullRequestPaths).toEqual(['src/**', 'x/*.go']);`)).toBe('');
    expect(pinFinding(`${OPTS}expect(a.pullRequestPaths).toStrictEqual(["src/**"]);`)).toBe('');
  });

  it('NEGATIVE CONTROL: a const bound to a literal array is a pin, `as const` too', () => {
    expect(pinFinding(`const P = ['src/**'];\n${OPTS}expect(a.pullRequestPaths).toEqual(P);`)).toBe(
      '',
    );
    expect(
      pinFinding(
        `const P = ['src/**', 'y/**'] as const;\n${OPTS}expect(a.pullRequestPaths).toEqual(P);`,
      ),
    ).toBe('');
  });

  it('NEGATIVE CONTROL: an ALIASED subject is a pin — the value, not the spelling', () => {
    // Round 1 false-positived here, and a guard that reds on a correct form is
    // how "edit the guard" becomes the routine way back to green.
    expect(pinFinding(`${OPTS}const p = a.pullRequestPaths;\nexpect(p).toEqual(['src/**']);`)).toBe(
      '',
    );
    expect(
      pinFinding(`${OPTS}const { pullRequestPaths: got } = a;\nexpect(got).toEqual(['src/**']);`),
    ).toBe('');
  });

  it('a multi-line `expect(...)` still counts — the pin is not required on one line', () => {
    expect(
      pinFinding(
        [
          OPTS.trim(),
          'expect(',
          '  a.pullRequestPaths,',
          "  'the filter must cover what the gate protects',",
          ").toEqual(['src/**']);",
        ].join('\n'),
      ),
    ).toBe('');
  });

  it('a pin that survives only in a COMMENT does not satisfy it, block or line', () => {
    expect(pinFinding(`${OPTS}// expect(a.pullRequestPaths).toEqual(['src/**']);`)).toMatch(
      /no CONTENTS pin/,
    );
    expect(pinFinding(`${OPTS}/* expect(a.pullRequestPaths).toEqual(['src/**']); */`)).toMatch(
      /no CONTENTS pin/,
    );
  });

  it('a QUOTED option key is still a caller — the literal view sees it', () => {
    // Under `blankNonCode` the key was emptied, so `{ ['allowPathsFilter']: true }`
    // escaped the caller check AND the exactly-one-declarer anchor.
    const { callers } = auditAllowPathsCallers([
      {
        path: 'tests/quoted-key.test.ts',
        source: "auditBlockingGate({ ['allowPathsFilter']: true });",
      },
    ]);
    expect(callers).toEqual(['tests/quoted-key.test.ts']);
  });

  it('a file that merely MENTIONS the option in a comment is not a caller', () => {
    // The counter-half of the blanking: header comments discuss this option all
    // over the repo, and claiming them would make the finding list noise — which
    // is how a scan trains people to ignore it.
    const { callers } = auditAllowPathsCallers([
      { path: 'tests/prose.test.ts', source: '// the audit takes allowPathsFilter; see #677\n' },
    ]);
    expect(callers).toEqual([]);
  });
});
