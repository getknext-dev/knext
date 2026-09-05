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
import { basename, extname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import { COMMENT_PREFIX } from '../scripts/lib/mutation-harness.mjs';
import {
  activeGuardProverExemptions,
  activeProverAuditExemptions,
  auditAnchorLiveness,
  auditProverSource,
  auditRunnerResolution,
  auditSpecFrameworkMatch,
  codeStringLiterals,
  discoverProvers,
  evaluateProverRun,
  GUARD_PROVER_EXEMPTIONS,
  isSharedMutationDriver,
  mutatesViaHarness,
  PROVER_AUDIT_EXEMPTIONS,
  PROVER_RE,
  proverPathBindings,
  RESOLVER_DEFINITION_FILE,
  SHARED_MUTATION_DRIVERS,
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
      if (isSharedMutationDriver(relPath, read(resolve(REPO_ROOT, relPath)))) continue;
      expect(
        PROVER_RE.test(basename(relPath)) && relPath === `scripts/${basename(relPath)}`,
        `${relPath} mutates tracked files via lib/mutation-harness.mjs but does not match scripts/${PROVER_RE.source} — the lane discovers by that glob, so it would never run`,
      ).toBe(true);
    }
  });

  it('the shared-driver exemption is PATH-anchored and cannot hide a prover', () => {
    // The exemption's own guard. #693 already had a SHAPE-based exemption here
    // that a file could buy by copying a function name; this one is a path, and
    // the two properties below are what stop the path from being a hole.
    expect(SHARED_MUTATION_DRIVERS.length, 'the exemption list is empty').toBeGreaterThan(0);
    for (const relPath of SHARED_MUTATION_DRIVERS) {
      // Under scripts/lib/, so the lane's `scripts/*.mjs` glob can never mistake
      // it for a prover in the first place.
      expect(relPath.startsWith('scripts/lib/'), `${relPath} is not under scripts/lib/`).toBe(true);
      expect(existsSync(resolve(REPO_ROOT, relPath)), `${relPath} does not exist`).toBe(true);
      // And it is a DRIVER, not a prover: the moment it declares or records
      // mutations it stops being exempt, because then it IS a prover the lane
      // cannot discover — the exact failure this describe block is about.
      expect(isSharedMutationDriver(relPath, read(resolve(REPO_ROOT, relPath)))).toBe(true);
    }
  });

  it('a "driver" that declares mutations LOSES the exemption', () => {
    // Mutation-proved by construction: the discriminator is exercised directly,
    // so a future edit that made the exemption unconditional reds here.
    expect(
      isSharedMutationDriver(
        SHARED_MUTATION_DRIVERS[0] as string,
        "import { mutate } from './mutation-harness.mjs';\ndeclareMutations(3);\n",
      ),
    ).toBe(false);
  });

  it('a file NOT on the list is never exempt, whatever it contains', () => {
    expect(isSharedMutationDriver('scripts/lib/pretending.mjs', 'const a = 1;')).toBe(false);
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

describe('#912 a prover whose anchors no longer match its subjects is a PR-time finding', () => {
  /**
   * THE FAILURE THIS EXISTS FOR, measured on the tip of sprint 2.
   *
   * `mutation-prove-install-smoke-coverage.mjs` declares 22 mutations. Ten of
   * them anchor on `{{ standalonePrefix }}` text that ADR-0048 deleted from the
   * templates, so its preflight ABORTS on the first one and the script exits 2
   * before planting anything. `mutation-prove-release-lane.mjs` reads
   * `pnpm-lock.yaml`, which left the workspace, and ENOENTs the same way.
   *
   * Both were caught by running the fleet by hand. Nothing in CI said a word:
   * the nightly reports a failed prover, but only ONCE A NIGHT and only after
   * the fact, and in the meantime the guards those provers cover read as PROVED
   * in every PR body that cites them. That is this repo's most common defect
   * shape — a control that reports success while inert — applied to the machine
   * that exists to detect it.
   *
   * So liveness is checked STATICALLY, at PR time, from the prover's own source:
   * resolve each `mutate(target, anchor, …)` to a file and an anchor, and count.
   * Exactly one occurrence is live. Zero means the subject moved and the prover
   * is inert. More than one means `assertAnchorOnce` would abort, which is the
   * same inertness with a different message.
   *
   * NON-VACUITY IS THE WHOLE RISK HERE, and it gets its own assertion. A static
   * extractor that silently parses nothing reports zero dead anchors and looks
   * identical to a clean tree — the exact shape being guarded against, one level
   * up. So the corpus size is asserted too, and an anchor the extractor cannot
   * resolve is REPORTED rather than dropped.
   */
  const provers = discoverProvers(REPO_ROOT);
  const readTarget = (rel: string) => {
    const p = resolve(REPO_ROOT, rel);
    return existsSync(p) ? read(p) : undefined;
  };

  it('resolves a real corpus of anchors across the fleet (non-vacuity)', () => {
    const total = provers.reduce(
      (n, p) => n + auditAnchorLiveness(read(p.absPath), readTarget).resolved.length,
      0,
    );
    // MEASURED on the tree, and RE-measured twice. Round 1 of this comment said
    // "14 anchors resolve today" when the real figure was 20 — written before this
    // branch added a prover and never re-derived. Round 2 raised it to 45, after
    // review found the driver shape unreadable and the extractors were taught to
    // read it (+16) and to follow const-valued anchors (+9).
    //
    // TODAY, and these are the numbers the PR body must match: 46 anchors and 24
    // read-subjects across 23 provers; 9 provers are anchor-covered, 16 have at
    // least one audited subject, and the 7 that have neither each carry a DATED
    // exemption in PROVER_AUDIT_EXEMPTIONS. "The rest are covered by subject
    // existence" was the round-1 claim and it was false for eleven of them.
    //
    // It was 22 before this audit existed. Ten of those were DEAD
    // (`{{ standalonePrefix }}` text ADR-0048 deleted); retiring the seven with
    // no vinext-era subject is what the audit was FOR, so a floor set to "keep
    // the old number" would have made honest retirement the thing that reds.
    //
    // The floor stops the extractor rotting: one that quietly parses nothing
    // reports zero dead anchors and reads exactly like a clean tree.
    expect(total).toBeGreaterThanOrEqual(40);
  });

  it('EVERY prover resolves at least one anchor or one read-subject', () => {
    // THE REVIEW FINDING (#927 round 1), and the reason the aggregate floor
    // above is not enough on its own.
    //
    // Four provers on this branch drive their mutations through
    // `createGuardProver({ subjects: { … } })`, which passes paths as
    // OBJECT-LITERAL VALUES rather than `const X = join(…)`. Both extractors
    // were blind to that shape, so all four reported anchors=0 AND bindings=0 —
    // completely unaudited — while the aggregate floor stayed comfortably green
    // on the other provers' 20. Repointing one of them at a DELETED file left
    // this whole file 120/120 green.
    //
    // That is the #912 defect class reintroduced by the fix for #912: the
    // cheapest path through the lane was the unguarded one. An aggregate cannot
    // see a hole in one member, so this asserts PER PROVER. A new prover in a
    // shape neither extractor understands now reds on arrival instead of being
    // silently exempt.
    const excused = activeProverAuditExemptions();
    const unaudited: string[] = [];
    const audited: string[] = [];
    for (const p of provers) {
      const src = read(p.absPath);
      const anchors = auditAnchorLiveness(src, readTarget).resolved.length;
      const bindings = proverPathBindings(src).length;
      if (anchors === 0 && bindings === 0) unaudited.push(p.relPath);
      else audited.push(p.relPath);
    }
    const unexcused = unaudited.filter((r) => !excused.has(r));
    expect(
      unexcused,
      'these provers are invisible to BOTH extractors and carry no dated exemption — a dead ' +
        `subject in them would report nothing:\n  ${unexcused.join('\n  ')}`,
    ).toEqual([]);

    // FAIL CLOSED THE OTHER WAY. An exemption for a prover that IS now audited
    // is stale text, and stale text in an exemption list is how a carve-out
    // outlives its reason — the same defect the `expires` field exists for,
    // arriving from the other direction.
    const stale = [...excused].filter((r) => audited.includes(r));
    expect(
      stale,
      `these provers ARE audited now; drop their exemption:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every audit exemption names a prover that exists, and has not lapsed', () => {
    // A lapsed entry silently stops excusing, which is correct — but an entry
    // naming a DELETED prover excuses nothing and hides that fact, so both
    // directions are checked. `activeProverAuditExemptions()` throws on a
    // malformed entry, which is the third direction.
    expect(PROVER_AUDIT_EXEMPTIONS.length).toBeGreaterThan(0);
    const known = new Set(provers.map((p) => p.relPath));
    for (const e of PROVER_AUDIT_EXEMPTIONS) {
      expect(known.has(e.prover), `${e.prover} is exempted but does not exist`).toBe(true);
    }
    expect(
      activeProverAuditExemptions().size,
      'every exemption has already lapsed — they are doing nothing and should be deleted',
    ).toBeGreaterThan(0);
  });

  it('no driver table entry vanishes unaccounted for (resolved + unresolved covers them all)', () => {
    // The FLEET-WIDE form of the case above, because the unit cases only prove
    // the extractor can do it — not that it does, on the provers in the tree.
    // published-image-closure.mjs declared SEVEN `subject:` entries and reported
    // six resolved with an EMPTY unresolved list; the per-prover check passed on
    // its bindings and the aggregate floor had slack, so nothing reddened.
    const shortfall: string[] = [];
    for (const p of provers) {
      const src = read(p.absPath);
      // Count table entries on the BLANKED view so a `subject:` inside a comment
      // or a string is not counted as a declaration.
      const declared = (blankNonCode(src).match(/(?<![.\w$])subject\s*:/g) ?? []).length;
      if (declared === 0) continue;
      const { resolved, unresolved } = auditAnchorLiveness(src, readTarget);
      // Inline `mutate(PATH, …)` anchors also land in `resolved`, so this is a
      // floor rather than an equality — it catches the DROP, which is the defect.
      if (resolved.length + unresolved.length < declared) {
        shortfall.push(
          `${p.relPath}: ${declared} table entries declared, only ${resolved.length + unresolved.length} accounted for`,
        );
      }
    }
    expect(shortfall, shortfall.join('\n  ')).toEqual([]);
  });

  it('every file a prover READS still exists', () => {
    // The half that reaches the provers whose anchors are not statically
    // resolvable. `mutation-prove-release-lane.mjs` bound `pnpm-lock.yaml` and
    // ENOENTed on every run from the day the workspace moved to bun — its
    // anchors never got far enough to be wrong, because the read failed first.
    const findings: string[] = [];
    let bindings = 0;
    for (const p of provers) {
      for (const b of proverPathBindings(read(p.absPath))) {
        bindings += 1;
        if (!existsSync(resolve(REPO_ROOT, b.path))) {
          findings.push(`${p.relPath}: reads ${b.name} = ${b.path}, which does not exist`);
        }
      }
    }
    expect(bindings, 'no read-bindings resolved — the scan would pass vacuously').toBeGreaterThan(
      8,
    );
    expect(findings, findings.join('\n  ')).toEqual([]);
  });

  describe('#927 the driver shape is audited, not exempt', () => {
    /**
     * `createGuardProver({ repoRoot, spec, subjects: { key: 'path' } })` plus a
     * table of `{ subject: 'key', anchor: '…' }` is the shape four provers on
     * this branch use. Review measured it invisible to both extractors. These
     * cases pin the fix, in both directions.
     */
    const DRIVER_PROVER = [
      "import { createGuardProver } from './lib/guard-prover.mjs';",
      'const prover = createGuardProver({',
      '  repoRoot: REPO_ROOT,',
      "  spec: 'tests/x.test.ts',",
      '  subjects: {',
      "    matrix: 'docs/thing.md',",
      '  },',
      '});',
      'const MUTATIONS = [',
      '  {',
      "    id: 'M1',",
      "    expect: 'red',",
      "    subject: 'matrix',",
      "    anchor: 'the anchor text',",
      "    replacement: 'other',",
      '  },',
      '];',
    ].join('\n');

    it('resolves an anchor reached through the subjects map', () => {
      const { resolved, findings } = auditAnchorLiveness(
        DRIVER_PROVER,
        () => 'a file containing the anchor text once\n',
      );
      expect(resolved).toEqual([{ file: 'docs/thing.md', anchor: 'the anchor text', count: 1 }]);
      expect(findings).toEqual([]);
    });

    it('a DEAD anchor in the driver shape IS a finding', () => {
      const { findings } = auditAnchorLiveness(DRIVER_PROVER, () => 'nothing of the sort\n');
      expect(findings.join(' ')).toMatch(/0 time\(s\)/);
    });

    it('a DELETED subject file IS a finding — the case that stayed green', () => {
      // Measured by review: repointing native-integrity's subject at a deleted
      // file left the lane 120/120 green. This is that exact scenario.
      const { findings } = auditAnchorLiveness(DRIVER_PROVER, () => undefined);
      expect(findings.join(' ')).toMatch(/does not exist/);
    });

    it('the subjects map is reported as a read-binding too', () => {
      // Belt and braces: even if a prover's anchors were unresolvable, its
      // subjects must still be existence-checked.
      expect(proverPathBindings(DRIVER_PROVER).map((b) => b.path)).toContain('docs/thing.md');
    });

    it('a COMMENT inside the subjects object does not hide it', () => {
      // Measured, not anticipated: matching the key on RAW source made an entry
      // beginning with `//` fail the key regex, and the prover carrying that
      // comment went silently unaudited. The per-prover check above caught it.
      const src = [
        'createGuardProver({',
        '  subjects: {',
        '    // why this is the only subject',
        "    matrix: 'docs/thing.md',",
        '  },',
        '});',
      ].join('\n');
      expect(proverPathBindings(src).map((b) => b.path)).toContain('docs/thing.md');
    });

    it('a COMMENT inside a table ENTRY does not drop the entry', () => {
      // The #927 round-2 fix applied to `subjects` and NOT to the sibling that
      // reads the table — the same defect, left one function over. Keys were
      // matched on RAW source, so a comment line inside a
      // `{ subject, anchor }` entry made the key regex fail and the whole entry
      // vanished: resolved=[], findings=[], unresolved=[]. Silent in all three
      // outputs at once.
      const src = [
        "const prover = createGuardProver({ subjects: { g: 'a.txt' } });",
        'const M = [',
        '  {',
        "    id: 'M1',",
        '    // why this mutation matters',
        "    subject: 'g',",
        '    // and what it anchors on',
        "    anchor: 'live text',",
        "    replacement: 'x',",
        '  },',
        '];',
      ].join('\n');
      const { resolved } = auditAnchorLiveness(src, () => 'live text\n');
      expect(resolved).toEqual([{ file: 'a.txt', anchor: 'live text', count: 1 }]);
    });

    it('an unresolvable table anchor is REPORTED, never silently dropped', () => {
      // The module's own invariant (see its header): "an argument it cannot
      // resolve is returned in `unresolved` rather than dropped, because a
      // dropped anchor is indistinguishable from a live one in the summary".
      // `driverTableAnchors` contradicted it with a bare `continue`.
      const src = [
        "const prover = createGuardProver({ subjects: { g: 'a.txt' } });",
        "const M = [{ subject: 'g', anchor: someRuntimeExpression(), replacement: 'x' }];",
      ].join('\n');
      const { resolved, unresolved } = auditAnchorLiveness(src, () => 'whatever\n');
      expect(resolved).toEqual([]);
      expect(unresolved.length).toBeGreaterThan(0);
    });

    it('a TEMPLATE-LITERAL anchor built from string consts resolves', () => {
      // The live instance: mutation-prove-published-image-closure.mjs's M2
      // anchors on `\${AUDIT_STEP}\\n` wrapped in indentation. It is a perfectly
      // ordinary anchor — the interpolation is a plain const — and it was the
      // one entry of seven that disappeared.
      const src = [
        "const STEP = 'run: node audit.mjs';",
        "const prover = createGuardProver({ subjects: { g: 'a.txt' } });",
        "const M = [{ subject: 'g', anchor: `  ${STEP}\\n`, replacement: '' }];",
      ].join('\n');
      const { resolved, unresolved } = auditAnchorLiveness(
        src,
        () => 'before\n  run: node audit.mjs\nafter\n',
      );
      expect(unresolved).toEqual([]);
      expect(resolved).toEqual([{ file: 'a.txt', anchor: '  run: node audit.mjs\n', count: 1 }]);
    });

    it('a template literal with a CONCATENATED tail is not silently truncated', () => {
      // The template branch closed on `lastIndexOf('\`')` and ignored whatever
      // followed, so `\`a\${X}\` + 'TAIL'` resolved to "aMID" — an anchor the prover
      // never uses. Worse than a miss: the audit then COUNTS the wrong string, so
      // a target containing the truncated form exactly once reports a live,
      // healthy anchor for a mutation that would abort at the harness.
      //
      // Reported as unresolved rather than half-read, per this module's rule
      // that a dropped anchor is indistinguishable from a live one.
      const src = [
        "const X = 'MID';",
        "const prover = createGuardProver({ subjects: { g: 'a.txt' } });",
        "const M = [{ subject: 'g', anchor: `a${X}` + 'TAIL', replacement: 'z' }];",
      ].join('\n');
      // A target where the TRUNCATED anchor occurs exactly once and the real one
      // does not occur at all — the fully silent shape.
      const { resolved, findings, unresolved } = auditAnchorLiveness(src, () => 'aMID only\n');
      expect(resolved, 'a truncated anchor must never be reported as resolved').toEqual([]);
      expect(findings).toEqual([]);
      expect(unresolved.length).toBeGreaterThan(0);
    });

    it('a template literal with an UNKNOWN interpolation is reported, not dropped', () => {
      const src = [
        "const prover = createGuardProver({ subjects: { g: 'a.txt' } });",
        "const M = [{ subject: 'g', anchor: `${runtimeThing}`, replacement: 'x' }];",
      ].join('\n');
      const { resolved, unresolved } = auditAnchorLiveness(src, () => 'x\n');
      expect(resolved).toEqual([]);
      expect(unresolved.length).toBeGreaterThan(0);
    });

    it('a subject named by an IDENTIFIER resolves, not just a literal', () => {
      // `subjects: { guard: SPEC }` is the shape in the tree; following only
      // string literals would leave it silently unaudited.
      const src = [
        "const SPEC = 'tests/y.test.ts';",
        'const prover = createGuardProver({',
        '  subjects: { guard: SPEC },',
        '});',
        "const M = [{ subject: 'guard', anchor: 'zzz', replacement: 'q' }];",
      ].join('\n');
      expect(proverPathBindings(src).map((b) => b.path)).toContain('tests/y.test.ts');
    });
  });

  it.each(provers.map((p) => p.relPath))('%s: every resolved anchor is live', (relPath) => {
    const { findings } = auditAnchorLiveness(read(resolve(REPO_ROOT, relPath)), readTarget);
    expect(findings, `${relPath}:\n  ${findings.join('\n  ')}`).toEqual([]);
  });

  it('an anchor that no longer occurs in its subject IS a finding', () => {
    const { findings } = auditAnchorLiveness(
      [
        "const ROOT = '';",
        "const TPL = join(ROOT, 'templates', 'app.hbs');",
        "mutate(TPL, 'output: \"standalone\"', '');",
      ].join('\n'),
      () => 'a template that says nothing of the sort\n',
    );
    expect(findings.join(' ')).toMatch(/0 time\(s\)/);
  });

  it('an anchor occurring TWICE is a finding too — assertAnchorOnce would abort', () => {
    const { findings } = auditAnchorLiveness(
      ["const F = join(ROOT, 'a.txt');", "mutate(F, 'dup', 'x');"].join('\n'),
      () => 'dup\ndup\n',
    );
    expect(findings.join(' ')).toMatch(/2 time\(s\)/);
  });

  it('a live anchor is NOT a finding (the audit is not a tripwire)', () => {
    const { findings, resolved } = auditAnchorLiveness(
      ["const F = join(ROOT, 'a.txt');", "mutate(F, 'live', 'x');"].join('\n'),
      () => 'exactly one live occurrence\n',
    );
    expect(findings).toEqual([]);
    expect(resolved).toHaveLength(1);
  });

  it('an anchor whose SUBJECT FILE is gone is a finding, not a silent skip', () => {
    const { findings } = auditAnchorLiveness(
      ["const F = join(ROOT, 'deleted.txt');", "mutate(F, 'x', 'y');"].join('\n'),
      () => undefined,
    );
    expect(findings.join(' ')).toMatch(/does not exist/);
  });

  it('resolves an anchor reached through snapshot(), not just a bare path', () => {
    // The two prover shapes in the tree: `mutate(PATH, …)` and
    // `const snap = snapshot(PATH); mutate(snap, …)`. Following only the first
    // would leave every snapshot-style prover unaudited while reporting clean.
    const { resolved } = auditAnchorLiveness(
      [
        "const GUARD = join(ROOT, 'g.test.ts');",
        'const snap = snapshot(GUARD);',
        "mutate(snap, 'anchor-text', 'x');",
      ].join('\n'),
      () => 'anchor-text\n',
    );
    expect(resolved.map((r) => r.file)).toEqual(['g.test.ts']);
  });

  it('an anchor the extractor cannot resolve is REPORTED, never dropped', () => {
    // A dropped unparseable anchor is indistinguishable from a live one in the
    // summary, which is how a static audit rots into decoration.
    const { unresolved } = auditAnchorLiveness(
      "mutate(SOMETHING_COMPUTED, `${prefix} tail`, 'x');",
      () => 'whatever',
    );
    expect(unresolved.length).toBeGreaterThan(0);
  });
});

/**
 * SPRINT 1'S NINE GUARDS, as data.
 *
 * Round 2 of this check validated the four EXEMPTION entries' shape against a
 * hardcoded `length 4` and enumerated nothing else, so it could not answer the
 * question SE-3 actually asks. A tenth guard shipping with neither a prover nor
 * an exemption tripped nothing — the check was about the exemptions, not about
 * the guards.
 *
 * The nine are listed because they are a closed historical set (sprint 1's PRs),
 * not something derivable from the tree. Everything else is DERIVED: which of
 * them a prover covers comes from reading the provers, and which are excused
 * comes from the dated exemptions. Set subtraction is the assertion.
 */
const SPRINT1_GUARDS: ReadonlyArray<{ pr: number; guard: string }> = [
  { pr: 896, guard: 'packages/kn-next/src/__tests__/create-scaffold.test.ts' },
  { pr: 897, guard: 'examples/bun-exec/test/alpine-image.docker-e2e.test.ts' },
  { pr: 898, guard: 'tests/compat-matrix.test.ts' },
  { pr: 899, guard: 'packages/kn-next/src/__tests__/cli-node-runtime.test.ts' },
  { pr: 901, guard: 'tests/coverage-gate.test.ts' },
  { pr: 903, guard: 'tests/published-image-closure-gate.test.ts' },
  { pr: 906, guard: 'packages/kn-next/src/__tests__/cache-handler-isr-staleness.test.ts' },
  { pr: 907, guard: 'packages/kn-next/src/__tests__/native-integrity.test.ts' },
  { pr: 908, guard: 'packages/kn-next/src/__tests__/observability-metric-contract.test.ts' },
];

describe('#927 SE-3 — every sprint-1 guard has a prover OR a dated exemption', () => {
  /**
   * The spec each prover PROVES, read from its own `const SPEC = '…'`.
   *
   * Deliberately NOT "any prover that mentions the path". `M15` of the
   * install-smoke prover names `create-scaffold.test.ts` as a GRADER — the spec
   * it reads a verdict from — which is a different relationship from being the
   * guard under proof. Counting a grader reference as coverage would mark #896
   * proven on the strength of a mutation about the `start` script, i.e. exactly
   * the false green this check exists to prevent.
   */
  /**
   * The spec a prover source declares as `const SPEC = '…'`, or undefined.
   *
   * ONE POSITION, not two matches. The first version ran the same regex twice —
   * once over the blanked view to establish the declaration is CODE, once over
   * the raw source to read the value — and then used the raw match's capture.
   * The two can land in different places: a comment containing
   * `const SPEC = 'some/other.test.ts'` above the real declaration satisfies the
   * blanked check via the real one while the raw match returns the comment's
   * path, so the wrong spec is credited as proven and a guard reads as covered
   * by a prover that does not touch it.
   *
   * The position now comes from the blanked view only, and the value is sliced
   * from the raw source starting at that same index — so the two cannot disagree
   * by construction.
   */
  const specOf = (source: string): string | undefined => {
    const blanked = blankNonCode(source);
    const m = /(?<![.\w$])const SPEC\s*=\s*'/.exec(blanked);
    if (!m) return undefined;
    const openQuote = m.index + m[0].length - 1;
    // Blanking empties a literal's CONTENTS but keeps its delimiters, so the
    // closing quote's position is readable from the blanked view too.
    const closeQuote = blanked.indexOf("'", openQuote + 1);
    if (closeQuote === -1) return undefined;
    return source.slice(openQuote + 1, closeQuote);
  };

  const provenSpecs = (): Set<string> => {
    const out = new Set<string>();
    for (const p of discoverProvers(REPO_ROOT)) {
      const spec = specOf(read(p.absPath));
      if (spec !== undefined) out.add(spec);
    }
    return out;
  };

  it('a decoy const SPEC in a COMMENT does not displace the real one', () => {
    // The two-match bug, as a case. Both regexes matched; they matched
    // different declarations; the raw one won.
    const src = [
      "// historical note: this used to be const SPEC = 'tests/old-and-wrong.test.ts'",
      "const SPEC = 'tests/the-real-one.test.ts';",
    ].join('\n');
    expect(specOf(src)).toBe('tests/the-real-one.test.ts');
  });

  it('a const SPEC that exists ONLY in a comment is not credited at all', () => {
    const src = "// const SPEC = 'tests/only-in-a-comment.test.ts'\nconst OTHER = 1;";
    expect(specOf(src)).toBeUndefined();
  });

  it('reads the value, not the blanked placeholder', () => {
    // The other half: reading the position from the blanked view is only correct
    // if the VALUE still comes from the raw source.
    expect(specOf("const SPEC = 'tests/x.test.ts';")).toBe('tests/x.test.ts');
  });

  it('reads a real set of proven specs (non-vacuity)', () => {
    // Without this, a regex that stopped matching would report every guard
    // unproven — or, with the subtraction below, every guard "not proven but
    // exempt" — and the failure would look like a policy problem, not a bug.
    expect(provenSpecs().size).toBeGreaterThan(8);
  });

  it('every sprint-1 guard is a real file (the list has not rotted)', () => {
    expect(SPRINT1_GUARDS).toHaveLength(9);
    for (const { pr, guard } of SPRINT1_GUARDS) {
      expect(existsSync(resolve(REPO_ROOT, guard)), `#${pr}: ${guard} does not exist`).toBe(true);
    }
  });

  it('NINE minus proven minus excused is EMPTY', () => {
    // The whole check, in one line of set arithmetic. A guard added to
    // SPRINT1_GUARDS with neither a prover nor an exemption reds here, which is
    // what round 2 could not do.
    const proven = provenSpecs();
    const excused = activeGuardProverExemptions();
    const uncovered = SPRINT1_GUARDS.filter(
      ({ guard }) => !proven.has(guard) && !excused.has(guard),
    );
    expect(
      uncovered.map((u) => `#${u.pr} ${u.guard}`),
      'these sprint-1 guards have neither a committed prover nor a live dated exemption (SE-3)',
    ).toEqual([]);
  });

  it('the split is 6 proven / 3 excused — and both halves are asserted', () => {
    // Stated as numbers so a silent migration between the two columns — an
    // exemption quietly replacing a prover — is visible rather than absorbed by
    // the subtraction above, which is satisfied either way.
    // 5/4 → 6/3 (sprint-3 A5): #906's guard moved from the excused column to
    // the proven one — `mutation-prove-isr-staleness.mjs` landed and the #928
    // exemption entry was removed in the same commit.
    const proven = provenSpecs();
    const excused = activeGuardProverExemptions();
    expect(SPRINT1_GUARDS.filter(({ guard }) => proven.has(guard))).toHaveLength(6);
    expect(SPRINT1_GUARDS.filter(({ guard }) => excused.has(guard))).toHaveLength(3);
  });

  it('no guard is BOTH proven and excused (a stale exemption)', () => {
    const proven = provenSpecs();
    const excused = activeGuardProverExemptions();
    const both = SPRINT1_GUARDS.filter(({ guard }) => proven.has(guard) && excused.has(guard)).map(
      (g) => g.guard,
    );
    expect(both, 'a prover exists; drop the exemption').toEqual([]);
  });

  it('every exemption names one of the nine (not some unrelated file)', () => {
    const nine = new Set(SPRINT1_GUARDS.map((g) => g.guard));
    for (const e of GUARD_PROVER_EXEMPTIONS) {
      expect(nine.has(e.guard), `${e.guard} is exempted but is not one of sprint 1's nine`).toBe(
        true,
      );
    }
  });

  it('each exempted guard is a real spec file', () => {
    // 4 → 3 (sprint-3 A5): #906's entry left the list when its prover landed
    // (`mutation-prove-isr-staleness.mjs`), the shrinkage #928 exists to track.
    expect(GUARD_PROVER_EXEMPTIONS.length).toBe(3);
    for (const e of GUARD_PROVER_EXEMPTIONS) {
      expect(existsSync(resolve(REPO_ROOT, e.guard)), `${e.guard} does not exist`).toBe(true);
    }
  });

  it('every exemption carries a justification, a date and a live clock', () => {
    // `activeGuardProverExemptions` throws on a malformed entry — unknown key,
    // missing `expires`, an expiry on or before `added`, a duplicate subject.
    expect(activeGuardProverExemptions().size).toBe(GUARD_PROVER_EXEMPTIONS.length);
  });

  it('EXPIRY FAILS CLOSED — past the dates, the three become uncovered', () => {
    // Not just "nothing is excused": the consequence is that the subtraction
    // above stops being empty, which is the behaviour that makes the date mean
    // something. 4 → 3 (sprint-3 A5): #906 is now proven, so its lapse-day
    // exposure moved from this list to the proven column for good.
    const future = new Date('2099-01-01T00:00:00Z');
    expect(activeGuardProverExemptions(future).size).toBe(0);
    const proven = provenSpecs();
    const stillUncovered = SPRINT1_GUARDS.filter(({ guard }) => !proven.has(guard));
    expect(stillUncovered).toHaveLength(3);
  });

  it('every exemption points at the tracking issue', () => {
    // Without a live issue number the expiry has nowhere to land: the entry
    // lapses, someone re-dates it, and no work is ever scheduled.
    for (const e of GUARD_PROVER_EXEMPTIONS) {
      expect(`${e.note ?? ''}`, `${e.guard} cites no tracking issue`).toMatch(/#\d+/);
    }
  });
});

describe('#942 F5 — every prover subject is MARKABLE, asserted at PR time', () => {
  /**
   * THE CLASS THIS CLOSES. `mutate()` throws BEFORE writing when a subject's
   * extension is in no COMMENT_PREFIX entry and the call passes no explicit
   * `commentPrefix` — so the prover dies mid-sweep with everything before it
   * already reported. The release-lane prover lived in exactly that state for
   * weeks after #912 repointed mutation 21 at bun.lock: the PR-time audits were
   * green (the file existed, the anchor matched once) because the miss was
   * neither of the two things they check, and `declared==run` was cited as
   * proved off runs that stopped at 20 of 22. The nightly is the wrong speed
   * for that discovery; this is the review-speed half.
   *
   * WHAT IT ASSERTS, per prover: every path binding (const reads, snapshot()
   * targets, driver `subjects` entries) whose extension is NOT in
   * COMMENT_PREFIX requires the prover to pass `commentPrefix` somewhere in
   * CODE (not prose — the source is blanked first). Deliberately coarse:
   * prover-level, not per-call, because statically pairing each mutate() with
   * its options object is the enumeration trap. The coarse form still catches
   * the incident shape — a prover mutating an unmappable subject with NO
   * escape hatch anywhere — and the fix message pushes toward the durable
   * repair (add the extension to COMMENT_PREFIX) rather than the local one.
   */
  const provers = discoverProvers(REPO_ROOT);

  it('non-vacuity: the extension map itself covers the workhorse types', () => {
    // If COMMENT_PREFIX ever shrank to nothing, every per-prover check below
    // would demand `commentPrefix` everywhere or nothing — either way, noise.
    for (const ext of ['.ts', '.mjs', '.yml', '.lock', '.json']) {
      expect(ext in COMMENT_PREFIX, `COMMENT_PREFIX lost ${ext}`).toBe(true);
    }
  });

  it.each(provers.map((p) => p.relPath))('%s can mark every subject it mutates', (relPath) => {
    const prover = provers.find((p) => p.relPath === relPath);
    if (!prover) throw new Error(`prover ${relPath} vanished mid-run`);
    const src = read(prover.absPath);
    const unmappable = proverPathBindings(src)
      .map((b) => b.path)
      .filter((path) => !(extname(path).toLowerCase() in COMMENT_PREFIX));
    if (unmappable.length === 0) return;
    expect(
      blankNonCode(src).includes('commentPrefix'),
      `${relPath} touches ${unmappable.join(', ')}, whose extension has no COMMENT_PREFIX ` +
        'entry, and never passes an explicit commentPrefix — mutate() will THROW mid-sweep at ' +
        'run time, which is how the release-lane prover silently stopped at 21/22 (#942 F5). ' +
        'Prefer adding the extension to COMMENT_PREFIX in scripts/lib/mutation-harness.mjs; ' +
        'pass { commentPrefix } only when the comment syntax is genuinely file-specific.',
    ).toBe(true);
  });
});
