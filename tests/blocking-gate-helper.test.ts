import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditBlockingGate } from './helpers/blocking-gate';

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

/** The same, with the audit's options — used by the `allowPathsFilter` block. */
function auditWith(yaml: string, options: { allowPathsFilter?: boolean }) {
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
    const PATHS = "  pull_request:\n    paths: ['src/**']\n";

    it('permits the `paths:` filter, and REPORTS what it permitted', () => {
      const a = auditWith(CLEAN.replace('  pull_request:\n', PATHS), { allowPathsFilter: true });
      expect(a.problems, a.problems.join('\n')).toEqual([]);
      // Non-vacuity: the caller must be able to assert the filter's CONTENTS
      // cover what the gate protects, so the audit hands them back.
      expect(a.pullRequestPaths).toEqual(['src/**']);
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
