import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import {
  auditProverSource,
  auditRunnerResolution,
  auditSpecFrameworkMatch,
  codeStringLiterals,
  discoverProvers,
  evaluateProverRun,
  mutatesViaHarness,
  PROVER_RE,
  RESOLVER_DEFINITION_FILE,
} from '../scripts/lib/prover-lane.mjs';
import { PROVER_SUMMARY_PREFIX, parseProverSummary } from '../scripts/lib/prover-report.mjs';
import { auditJobCanNotSkip } from './helpers/blocking-gate.js';

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
const LANE_JOB_ID = 'run-mutation-provers';

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

describe("#902 a prover's runner can execute its spec's framework", () => {
  const provers = discoverProvers(REPO_ROOT);
  const readSpec = (spec: string): string | undefined => {
    const p = resolve(REPO_ROOT, spec);
    return existsSync(p) ? read(p) : undefined;
  };

  it.each(provers.map((p) => p.relPath))('%s has no framework mismatch', (relPath) => {
    const findings = auditSpecFrameworkMatch(read(resolve(REPO_ROOT, relPath)), readSpec);
    expect(findings, `${relPath}: ${findings.join(' | ')}`).toEqual([]);
  });

  it('a vitest-resolved prover aimed at a bun:test spec IS a finding', () => {
    const findings = auditSpecFrameworkMatch(
      "import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';\n" +
        "const SPEC = 'fake/spec.test.ts';\nresolveTestRunner(root);",
      () => "import { it } from 'bun:test';",
    );
    expect(findings.join(' ')).toMatch(/bun:test .* through resolveTestRunner/);
  });
});

describe('#685 every prover resolves its test runner via resolveTestRunner', () => {
  const provers = discoverProvers(REPO_ROOT);

  it.each(provers.map((p) => p.relPath))('%s has no audit finding', (relPath) => {
    const findings = auditProverSource(read(resolve(REPO_ROOT, relPath)), relPath);
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
      const relPath = `scripts/lib/${helper}`;
      const findings = auditRunnerResolution(read(resolve(libDir, helper)), relPath);
      expect(findings, `${relPath}: ${findings.join(' | ')}`).toEqual([]);
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

describe('#693 the lane job can NOT be conditioned off — a skip is silent AND unwatched', () => {
  // The `continue-on-error` scan above is only ONE of the two soft-fail shapes.
  // A job-level `if:` on `run-mutation-provers` makes the job SKIP; a skipped job
  // does not fail the run; and `needs.run-mutation-provers.result` is then
  // `'skipped'`, not `'failure'`, so the pinned-issue alert never fires either.
  // The lane goes green AND unwatched — which is #685's own failure mode,
  // reproduced inside the lane built to end it.
  //
  // The repo already owns this check. `auditBlockingGate` has two halves and only
  // ONE of them is wrong for this workflow: the TRIGGER half certifies a job as an
  // unconditional PR gate, which this deliberately-scheduled lane is not. The
  // CAN-NOT-SKIP half (job-level `if:`, `continue-on-error` at job and step level,
  // an unrecognised job key, and the same walk over the transitive `needs:`
  // closure) applies to any job whose failure must fail its run. So that half is
  // reused rather than reimplemented — two implementations of one rule can only
  // diverge.
  const laneJobs = () => {
    const doc = parse(read(WORKFLOW_PATH)) as { jobs?: Record<string, unknown> } | null;
    return (doc?.jobs ?? {}) as Record<string, never>;
  };

  it('the lane job, and everything it needs, carries no disarm', () => {
    const problems: string[] = [];
    const closure = auditJobCanNotSkip(laneJobs(), LANE_JOB_ID, problems);
    expect(problems, problems.join(' | ')).toEqual([]);
    expect(closure, 'the audit must have actually reached the lane job').toContain(LANE_JOB_ID);
  });

  it('MUTATION-PROOF: a job-level `if:` on the lane job IS a finding', () => {
    const jobs = laneJobs() as unknown as Record<string, Record<string, unknown>>;
    (jobs[LANE_JOB_ID] as Record<string, unknown>).if = "github.actor != 'dependabot[bot]'";
    const problems: string[] = [];
    auditJobCanNotSkip(jobs as unknown as Record<string, never>, LANE_JOB_ID, problems);
    expect(problems.join(' ')).toMatch(/job-level `if:`/);
  });

  it('MUTATION-PROOF: a step-level continue-on-error in the lane job IS a finding', () => {
    const jobs = laneJobs() as unknown as Record<string, { steps: Array<Record<string, unknown>> }>;
    (jobs[LANE_JOB_ID] as { steps: Array<Record<string, unknown>> }).steps[0]['continue-on-error'] =
      true;
    const problems: string[] = [];
    auditJobCanNotSkip(jobs as unknown as Record<string, never>, LANE_JOB_ID, problems);
    expect(problems.join(' ')).toMatch(/continue-on-error/);
  });
});

describe('#693 the resolveTestRunner exemption is anchored to the DEFINITION FILE', () => {
  // Round 1 exempted any file matching `/function\s+resolveTestRunner\b/`. That is
  // shape-based, not path-anchored, so COPYING the function name — the exact
  // copy-instead-of-share failure this lane exists to stop — bought a file a full
  // exemption from the package-manager-spawn half. And because `callsFunction` is
  // satisfied by a DECLARATION, the same copied name satisfied the second half
  // too. One copied function name defeated both.
  const IMPOSTOR = [
    'function resolveTestRunner() { return null; }',
    "spawnSync('pnpm', ['exec', 'vitest', 'run', spec]);",
  ].join('\n');

  it('a file that merely COPIES the function name is still a finding', () => {
    expect(auditRunnerResolution(IMPOSTOR, 'scripts/lib/impostor.mjs').join(' ')).toMatch(/pnpm/);
  });

  it('with no path supplied at all, nothing is exempt (the audit fails closed)', () => {
    expect(auditRunnerResolution(IMPOSTOR).join(' ')).toMatch(/pnpm/);
  });

  it('the real definition site IS exempt (its documented fallback is the one legal spawn)', () => {
    expect(auditRunnerResolution(IMPOSTOR, RESOLVER_DEFINITION_FILE)).toEqual([]);
    expect(
      auditRunnerResolution(
        read(resolve(REPO_ROOT, RESOLVER_DEFINITION_FILE)),
        RESOLVER_DEFINITION_FILE,
      ),
    ).toEqual([]);
  });

  it('exactly ONE tracked file defines resolveTestRunner, and it is that path', () => {
    // The exemption is only sound while the definition is unique. A second
    // definition anywhere is the copy-instead-of-share failure again, and this is
    // the assertion that makes it loud instead of silently exempt.
    const tracked = execFileSync('git', ['ls-files', '-z', '*.mjs', '*.ts'], { cwd: REPO_ROOT })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(20);
    // Blanked, so a definition QUOTED in a string literal — as this very file
    // quotes one two tests up — is not counted as a definition. It is not one.
    const definers = tracked.filter((p) =>
      /function\s+resolveTestRunner\b/.test(blankNonCode(read(resolve(REPO_ROOT, p)))),
    );
    expect(definers, `resolveTestRunner is defined in: ${definers.join(', ')}`).toEqual([
      RESOLVER_DEFINITION_FILE,
    ]);
  });
});

describe('#693 the spawner scan is not limited to an enumerated list', () => {
  // `SPAWNERS` was an enumeration, and an enumerated list of call sites is how
  // the second one gets missed: `exec` was absent, so
  // `exec('pnpm exec vitest run x')` produced ZERO findings. The binding names are
  // now DERIVED from the `node:child_process` import, so an API nobody listed here
  // is covered, while `regex.exec(...)` — which is everywhere in this repo — is not
  // a spawn and must not read as one.
  const PROVER_PATH = 'scripts/mutation-prove-example.mjs';

  it('exec(), imported from node:child_process, is a spawn', () => {
    const findings = auditRunnerResolution(
      ["import { exec } from 'node:child_process';", "exec('pnpm exec vitest run x');"].join('\n'),
      PROVER_PATH,
    );
    expect(findings.join(' ')).toMatch(/pnpm/);
  });

  it('an aliased import is a spawn under its alias', () => {
    const findings = auditRunnerResolution(
      [
        "import { execSync as sh } from 'node:child_process';",
        "sh('pnpm exec vitest run x');",
      ].join('\n'),
      PROVER_PATH,
    );
    expect(findings.join(' ')).toMatch(/pnpm/);
  });

  it('a namespace import is a spawn through its member calls', () => {
    const findings = auditRunnerResolution(
      [
        "import * as cp from 'node:child_process';",
        "cp.spawnSync('pnpm', ['exec', 'vitest']);",
      ].join('\n'),
      PROVER_PATH,
    );
    expect(findings.join(' ')).toMatch(/pnpm/);
  });

  it('regex .exec() is NOT a spawn, even next to a package-manager literal', () => {
    // Non-vacuity for the rule above: if this reds, the widened scan is a
    // false-positive machine and every `verify-action-pins`-shaped file breaks.
    expect(auditRunnerResolution("const m = /x/.exec('pnpm');", 'scripts/x.mjs')).toEqual([]);
  });
});

describe('#693 an off-convention prover is invisible to BOTH halves — so scan for it', () => {
  // `PROVER_RE` is one naming convention shared by the glob AND by the
  // `git ls-files` cross-check, so a prover named `prove-mutation-*.mjs` is
  // silently not run and the guard is unaffected — the convention cannot audit
  // itself. The independent signal is BEHAVIOURAL: a file that calls the
  // harness's mutating verbs IS a prover, whatever it is called.
  it('every tracked file that mutates via the harness matches the prover convention', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', '*.mjs'], { cwd: REPO_ROOT })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const mutators = tracked.filter((p) => mutatesViaHarness(read(resolve(REPO_ROOT, p))));
    // Non-vacuity: an empty list would make the loop below assert nothing.
    expect(mutators.length, 'no harness-mutating file found — the scan is vacuous').toBeGreaterThan(
      4,
    );
    for (const relPath of mutators) {
      expect(
        PROVER_RE.test(basename(relPath)) && relPath === `scripts/${basename(relPath)}`,
        `${relPath} mutates tracked files via lib/mutation-harness.mjs but does not match scripts/${PROVER_RE.source} — the lane discovers by that glob, so it would never run`,
      ).toBe(true);
    }
  });

  it('a file that only READS the harness marker is not claimed as a prover', () => {
    // `scripts/scan-mutation-residue.mjs` imports MUTATION_MARKER and mutates
    // nothing. Claiming it would force a rename that makes the lane run it as a
    // prover, which it is not.
    expect(mutatesViaHarness("import { MUTATION_MARKER } from './lib/mutation-harness.mjs';")).toBe(
      false,
    );
    expect(
      mutatesViaHarness("import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';"),
    ).toBe(true);
  });
});

describe('#693 the two behaviours the lane SELLS are asserted, not merely described', () => {
  it('the workflow asserts no mutation residue survived, unconditionally', () => {
    const text = read(WORKFLOW_PATH);
    const jobs = (
      parse(text) as { jobs: Record<string, { steps: Array<Record<string, unknown>> }> }
    ).jobs;
    const steps = jobs[LANE_JOB_ID]?.steps ?? [];
    const residue = steps.filter(
      (s) => typeof s.run === 'string' && /scan-mutation-residue\.mjs/.test(s.run as string),
    );
    expect(residue.length, 'no step runs scripts/scan-mutation-residue.mjs').toBe(1);
    const step = residue[0] as Record<string, unknown>;
    // `if: always()` is load-bearing: a residue check that only runs when the
    // provers passed cannot report the case it exists for — a failed prover that
    // left the tree dirty.
    expect(String(step.if ?? '')).toMatch(/always\(\)/);
    expect(step.run as string).toMatch(/git diff --exit-code/);
  });

  it('zero provers is a FAILURE, not a vacuous pass', () => {
    // Run the real lane runner against a tree that has the runner and its helpers
    // but no `scripts/mutation-prove-*.mjs` at all. Delete the guard in
    // `run-mutation-provers.mjs` and this exits 0 with "all 0 prover(s) ran every
    // mutation they declare" — the vacuous green the whole lane is against.
    const dir = mkdtempSync(join(tmpdir(), 'knext-empty-lane-'));
    try {
      mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
      cpSync(resolve(REPO_ROOT, LANE_RUNNER), join(dir, LANE_RUNNER));
      for (const f of readdirSync(resolve(REPO_ROOT, 'scripts/lib')).filter((n) =>
        n.endsWith('.mjs'),
      )) {
        cpSync(resolve(REPO_ROOT, 'scripts/lib', f), join(dir, 'scripts/lib', f));
      }
      const run = spawnSync(process.execPath, [join(dir, LANE_RUNNER)], { encoding: 'utf8' });
      expect(run.status, `stdout: ${run.stdout}\nstderr: ${run.stderr}`).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toMatch(/no scripts\/mutation-prove-\*\.mjs found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
