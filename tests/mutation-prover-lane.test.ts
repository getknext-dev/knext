import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditProverSource,
  auditRunnerResolution,
  codeStringLiterals,
  discoverProvers,
  evaluateProverRun,
} from '../scripts/lib/prover-lane.mjs';
import { PROVER_SUMMARY_PREFIX, parseProverSummary } from '../scripts/lib/prover-report.mjs';

/**
 * GUARDS for the mutation-prover nightly lane (#685).
 *
 * Two failures motivate this file, and they are different failures:
 *
 *   1. `resolveTestRunner` landed in #680/#681 and was applied ONLY to the two
 *      provers those PRs touched. `mutation-prove-residue-scan.mjs` and
 *      `mutation-prove-stale-pointer-scan.mjs` kept `pnpm exec vitest`, which
 *      resolves nothing in a tree without its own `node_modules`, so both have
 *      been silently non-functional in every worktree since. A fix that is not
 *      propagated is a fix with a countdown on it, so the propagation is SCANNED
 *      rather than enumerated: every `scripts/mutation-prove-*.mjs` is
 *      discovered by glob and audited, and an eighth prover written next month
 *      is covered without anyone remembering.
 *
 *   2. No CI job runs any prover. The nightly lane fixes that, but an
 *      exit-code-only lane would have called failure mode 4 GREEN:
 *      `mutation-prove-publish-markers.mjs` ran 4 of its 13 mutations for
 *      several PRs and exited 0. So every prover DECLARES its mutation count up
 *      front and the lane compares declared against run — in BOTH directions, so
 *      adding a mutation without bumping the declaration reds too, which is what
 *      keeps the declaration from rotting into a lie.
 *
 * The audit works on `blankNonCode`'d source, so a prover that MENTIONS
 * `pnpm exec vitest` in a comment (several do — it is the bug they document) is
 * not a finding, while one that spawns it is.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/mutation-prover-nightly.yml');
const LANE_RUNNER = 'scripts/run-mutation-provers.mjs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('#685 the prover set is DISCOVERED, never enumerated', () => {
  it('discovers every tracked scripts/mutation-prove-*.mjs', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', 'scripts/mutation-prove-*.mjs'], {
      cwd: REPO_ROOT,
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort();
    // Non-vacuity first: an empty glob would make every per-prover assertion
    // below pass by having nothing to assert on.
    expect(tracked.length, 'no mutation provers are tracked — the corpus is empty').toBeGreaterThan(
      4,
    );
    expect(discoverProvers(REPO_ROOT).map((p) => p.relPath)).toEqual(tracked);
  });
});

describe('#685 every prover resolves its test runner via resolveTestRunner', () => {
  const provers = discoverProvers(REPO_ROOT);

  it.each(provers.map((p) => p.relPath))('%s has no audit finding', (relPath) => {
    const findings = auditProverSource(read(resolve(REPO_ROOT, relPath)));
    expect(findings, `${relPath}: ${findings.join(' | ')}`).toEqual([]);
  });

  it('a prover that spawns `pnpm exec vitest` IS a finding (the guard is not decoration)', () => {
    const findings = auditProverSource(
      [
        "import { declareMutations, recordMutation } from './lib/prover-report.mjs';",
        'declareMutations(1);',
        "spawnSync('pnpm', ['exec', 'vitest', 'run', spec]);",
        'recordMutation();',
      ].join('\n'),
    );
    expect(findings.join(' ')).toMatch(/pnpm/);
  });

  it('a prover that never declares its mutation count IS a finding', () => {
    const findings = auditProverSource(
      [
        "import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';",
        'const R = 1;',
      ].join('\n'),
    );
    expect(findings.join(' ')).toMatch(/declareMutations/);
  });

  it('an IMPORT of declareMutations does not satisfy the check — only a CALL does', () => {
    // Measured while mutation-proving this guard: the first version asked
    // whether the identifier appeared anywhere in code, so deleting
    // `declareMutations(5);` left the guard GREEN off the surviving import line.
    const findings = auditProverSource(
      [
        "import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';",
        "import { declareMutations, recordMutation } from './lib/prover-report.mjs';",
        'const RUNNER = resolveTestRunner(REPO_ROOT);',
      ].join('\n'),
    );
    expect(findings.join(' ')).toMatch(/declareMutations/);
    expect(findings.join(' ')).toMatch(/recordMutation/);
  });

  it('a prover that spawns nothing and delegates to a shared proof helper is clean', () => {
    // `mutation-prove-ci-blocking-gates.mjs` runs its specs through
    // `runGateTest` in `lib/ci-blocking-gate-proof.mjs`, which resolves the
    // runner once for every caller. Requiring the identifier in EVERY prover
    // would red that correct shape and push it back to spawning its own.
    const findings = auditProverSource(
      [
        "import { runGateTest } from './lib/ci-blocking-gate-proof.mjs';",
        "import { declareMutations, recordMutation } from './lib/prover-report.mjs';",
        'declareMutations(1);',
        'runGateTest(gate);',
        'recordMutation();',
      ].join('\n'),
    );
    expect(findings).toEqual([]);
  });

  it('every shared scripts/lib helper is free of package-manager spawns too', () => {
    // The delegation above is only safe if the delegate is clean, so the same
    // literal scan runs over the whole shared-helper directory — by glob, so a
    // helper added later is covered.
    const libDir = resolve(REPO_ROOT, 'scripts/lib');
    const helpers = readdirSync(libDir).filter((f) => f.endsWith('.mjs'));
    expect(helpers.length).toBeGreaterThan(0);
    for (const helper of helpers) {
      const findings = auditRunnerResolution(read(resolve(libDir, helper)));
      expect(findings, `scripts/lib/${helper}: ${findings.join(' | ')}`).toEqual([]);
    }
  });

  it('a COMMENT mentioning pnpm exec vitest is not a finding (comments document the bug)', () => {
    const findings = auditProverSource(
      [
        '// this used to spawnSync("pnpm", ["exec", "vitest"]) and resolved nothing',
        "import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';",
        "import { declareMutations, recordMutation } from './lib/prover-report.mjs';",
        'declareMutations(1);',
        'recordMutation();',
      ].join('\n'),
    );
    expect(findings).toEqual([]);
  });
});

describe('#685 codeStringLiterals sees code, not comments', () => {
  it('reports literals in code and ignores those inside comments', () => {
    const found = codeStringLiterals(
      ['/* "in-a-block-comment" */', "// 'in-a-line-comment'", "const a = 'in-code';"].join('\n'),
    );
    expect(found).toContain('in-code');
    expect(found).not.toContain('in-a-block-comment');
    expect(found).not.toContain('in-a-line-comment');
  });

  it('reports the contents of a template literal (a backtick is not a hiding place)', () => {
    expect(codeStringLiterals('const cmd = `pnpm`;')).toContain('pnpm');
  });
});

describe('#685 the lane fails on a declared-vs-run mismatch, not only on the exit code', () => {
  const summary = (declared: number, run: number) =>
    `${PROVER_SUMMARY_PREFIX} ${JSON.stringify({ declared, run })}`;

  it('parses the summary line a prover emits', () => {
    expect(parseProverSummary(`noise\n${summary(13, 13)}\nmore noise`)).toEqual({
      declared: 13,
      run: 13,
    });
  });

  it('a clean run with matching counts passes', () => {
    expect(evaluateProverRun({ status: 0, output: summary(13, 13) }).findings).toEqual([]);
  });

  it('THE CASE THAT MATTERS: exit 0 with 4 of 13 mutations run is a FAILURE', () => {
    const { findings } = evaluateProverRun({ status: 0, output: summary(13, 4) });
    expect(findings.join(' ')).toMatch(/declared 13.*ran 4/);
  });

  it('run > declared is equally a failure (the declaration cannot rot upward)', () => {
    expect(evaluateProverRun({ status: 0, output: summary(3, 5) }).findings.length).toBe(1);
  });

  it('a non-zero exit is a failure even with matching counts', () => {
    expect(evaluateProverRun({ status: 1, output: summary(3, 3) }).findings.join(' ')).toMatch(
      /exit/,
    );
  });

  it('a missing summary line is a failure, never a pass', () => {
    expect(
      evaluateProverRun({ status: 0, output: '30 disarms went red as required' }).findings.join(
        ' ',
      ),
    ).toMatch(/summary/);
  });

  it('a prover declaring zero mutations is a failure (a vacuous green)', () => {
    expect(evaluateProverRun({ status: 0, output: summary(0, 0) }).findings.join(' ')).toMatch(
      /zero|0 mutations/,
    );
  });
});

describe('#685 the nightly workflow exists and is scheduled, NOT a PR gate', () => {
  it('the workflow file exists', () => {
    expect(() => read(WORKFLOW_PATH)).not.toThrow();
  });

  it('runs on a cron schedule plus workflow_dispatch', () => {
    const text = read(WORKFLOW_PATH);
    expect(/schedule:/.test(text)).toBe(true);
    expect(/-\s*cron:\s*['"][^'"]+['"]/.test(text)).toBe(true);
    expect(/workflow_dispatch/.test(text)).toBe(true);
  });

  it('does NOT run on pull_request or push (the provers mutate ci.yml and cost minutes)', () => {
    // Asserted on the trigger block only: the header prose explains WHY the lane
    // is not PR-triggered, and prose must not be able to satisfy — or violate —
    // the assertion.
    const text = read(WORKFLOW_PATH);
    const onBlock = text.slice(text.search(/^on:/m), text.search(/^permissions:/m));
    expect(onBlock.length, 'could not locate the on: block').toBeGreaterThan(0);
    expect(/pull_request/.test(onBlock)).toBe(false);
    expect(/^\s*push:/m.test(onBlock)).toBe(false);
  });

  it('runs the lane runner, which discovers the provers by glob', () => {
    expect(read(WORKFLOW_PATH)).toContain(`node ${LANE_RUNNER}`);
  });

  it('is a gate: nothing in it carries continue-on-error', () => {
    expect(/continue-on-error/.test(read(WORKFLOW_PATH))).toBe(false);
  });
});

describe('#685 the lane carries the pinned-issue alert (#670: a nightly needs an owner)', () => {
  it('has an alert job scoped to a FAILED scheduled run', () => {
    const text = read(WORKFLOW_PATH);
    expect(/github\.event_name == 'schedule'/.test(text)).toBe(true);
    expect(/result == 'failure'/.test(text)).toBe(true);
    expect(/always\(\)/.test(text)).toBe(true);
  });

  it('requests issues: write', () => {
    expect(/issues:\s*write/.test(read(WORKFLOW_PATH))).toBe(true);
  });

  it('is IDEMPOTENT: one pinned issue, commented on rather than duplicated', () => {
    const text = read(WORKFLOW_PATH);
    expect(/gh issue list/.test(text)).toBe(true);
    const limit = text.match(/gh issue list[\s\S]*?--limit\s+(\d+)/);
    expect(limit, 'the lookup must pass an explicit --limit').toBeTruthy();
    expect(Number((limit as RegExpMatchArray)[1])).toBeGreaterThanOrEqual(100);
    expect(/gh issue comment/.test(text)).toBe(true);
    expect(/gh issue create/.test(text)).toBe(true);
    expect(/gh issue pin/.test(text)).toBe(true);
    expect(
      text.match(/title=['"]([^'"$]+)['"]/),
      'a fixed literal title is the dedup key',
    ).toBeTruthy();
  });
});
