import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import {
  declaredTestTitles,
  disarmReplacement,
  GATE_TEST_NAME,
  GATES,
  jobAnchor,
  resolveTestRunner,
} from '../scripts/lib/ci-blocking-gate-proof.mjs';
import { codeWithLiterals } from '../scripts/lib/prover-lane.mjs';
import { auditJobCanNotSkip } from './helpers/blocking-gate.js';

/**
 * The standing proof must be RUNNABLE (#672 round 5).
 *
 * `scripts/mutation-prove-ci-blocking-gates.mjs` is cited by two files as the
 * evidence that the converted ci.yml blocking-gate guards are not decoration.
 * Nothing ran it, and nothing checked it could run — so it went offline and
 * stayed offline: `pnpm exec vitest` resolves nothing in a tree without its own
 * `node_modules` (a git worktree, a fresh clone before install), and the prover
 * reported that as `FATAL: <spec> has no test named "…"`. Wrong cause, so the
 * actionable next step was wrong too: the assertion names were never renamed.
 *
 * "A spec that cannot run is not a guard" is the finding #659 closed and the
 * reason #640 existed, and a prover that FATALs is WORSE than no prover because
 * its result is quoted as evidence. So the three ways it can go offline are now
 * checked here, cheaply, on every test run:
 *
 *   1. THE RUNNER CANNOT START — the launcher the prover uses is exercised.
 *   2. AN ASSERTION WAS RENAMED — the prover selects by `vitest -t <name>`, and
 *      `vitest -t` with a name that matches nothing EXITS 0, so a rename turns
 *      the whole proof into a no-op that reports success. The declaration is
 *      read from a CODE-ONLY view of the spec (#680), so a title left behind in
 *      a comment or a string does not satisfy this.
 *   3. A GATES SPEC MOVED — the `existsSync` below. That is the third cause of
 *      "nothing ran", and until #680 the prover misreported it as a dead runner.
 *
 * What it does NOT check is the prover's own attribution logic; that lives in
 * `tests/ci-blocking-gate-proof-diagnosis.test.ts`.
 *
 * This does not re-run the 25 mutations (that is minutes of vitest); it asserts
 * the proof is not offline, which is the failure that actually happened.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('the ci.yml blocking-gate mutation proof is runnable', () => {
  it('is non-vacuous: it covers every converted gate', () => {
    // Without this, emptying GATES would make the `it.each` blocks below pass
    // by iterating nothing — the same vacuity the prover itself guards against.
    expect(GATES.length).toBeGreaterThanOrEqual(6);
    expect(GATE_TEST_NAME.length).toBeGreaterThan(20);
    // Every gate carries a name to select by — a gate whose `testName` fell
    // through as undefined would make `vitest -t undefined` match nothing and
    // exit 0, i.e. the silent no-op this file exists to prevent.
    for (const gate of GATES) expect(gate.testName.length).toBeGreaterThan(20);
  });

  it('the test runner it launches actually starts, on a PATH it did not inherit', () => {
    // The failure that took the proof offline, and the assertion had to be
    // written twice: the first version spawned the runner with the INHERITED
    // environment and was decoration. Under vitest, `node_modules/.bin` is
    // already on PATH, so even the broken `pnpm exec vitest` fallback starts —
    // mutation-proved: breaking the resolver left that version GREEN.
    //
    // So two things are asserted, neither of which the ambient PATH can supply:
    // the resolver found a REAL binary on disk (not the last-resort fallback),
    // and that binary runs with PATH sanitised to the system default.
    const runner = resolveTestRunner(REPO_ROOT);
    expect(
      runner.args,
      `resolver fell back to \`${runner.command} ${runner.args.join(' ')}\` — no runner binary was found by walking up from ${REPO_ROOT}, so the proof cannot run`,
    ).toEqual([]);
    expect(existsSync(runner.command), `${runner.command} does not exist`).toBe(true);

    const res = spawnSync(runner.command, ['--version'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // `node` itself must stay reachable — the bin shim is a script that
      // execs it — but nothing else from the ambient PATH does, so a resolver
      // that resolved nothing cannot be rescued by the environment.
      env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    expect(
      res.status,
      `runner did not start: ${(res.stderr ?? '') || (res.error?.message ?? '')}`,
    ).toBe(0);
    expect(`${res.stdout ?? ''}`).toMatch(/vitest\//);
  });

  it.each(GATES)('$spec declares the assertion the proof selects by name', ({ spec, testName }) => {
    // `vitest -t <no match>` exits 0, so a rename would silently make the proof
    // a no-op. Asserted against the spec's DECLARED titles — code only, so a
    // rename reds here even when the old title survives in a comment or a string
    // (measured: that combination used to leave this guard 7/7 green, #680) —
    // instead of being discovered the next time someone runs the prover.
    const path = resolve(REPO_ROOT, spec);
    expect(existsSync(path), `${spec} is missing`).toBe(true);
    const titles = declaredTestTitles(readFileSync(path, 'utf8'));
    // Per-gate since #677: the paths-scoped image-pin gate declares a name that
    // says what it actually proves, so a single shared constant would either
    // miss it or make the proof select on a false claim.
    expect(
      titles.some((title) => title.includes(testName)),
      `${spec} declares no test whose name contains ${JSON.stringify(testName)} — found: ${JSON.stringify(titles)}`,
    ).toBe(true);
  });

  it('every gate names a workflow that exists, and its job anchor occurs exactly once', () => {
    // The prover mutates by the anchor `  <jobId>:\n`, which the harness refuses
    // unless it occurs EXACTLY once. A gate pointed at the wrong workflow (or a
    // renamed job) would take the proof offline at run time; this says so at PR
    // time, which is the whole reason this file exists.
    for (const gate of GATES) {
      const wf = resolve(REPO_ROOT, gate.workflow);
      expect(existsSync(wf), `${gate.workflow} is missing`).toBe(true);
      const anchor = `  ${gate.jobId}:\n`;
      const text = readFileSync(wf, 'utf8');
      expect(
        text.split(anchor).length - 1,
        `\`${gate.jobId}\` must appear exactly once as a job key in ${gate.workflow}`,
      ).toBe(1);
    }
  });
});

/**
 * The `needs:` disarm must red the guard FOR THE RIGHT REASON (#690).
 *
 * `needsDisarm` is free text per gate — correctly, since the shared form would
 * be a CYCLE on `image-pin-resolution-nightly.yml`, whose only other job
 * `needs:` the gate. Nothing checked the text, and the failure that hides behind
 * that is specific: `needs: no-such-job` makes the audit report *"job `no-such-job`
 * is not defined in this workflow"*, the guard goes RED, and the prover scores it
 * as PROVED. It proved the audit rejects an INVALID workflow — not that it
 * detects a disarm. Same for a `needs:` on a job that can never skip, and for a
 * cycle, which is not a valid workflow at all.
 *
 * So the disarm is applied here exactly as the prover applies it — through the
 * shared `disarmReplacement` — and the result is parsed and audited. A mutation
 * that does not disarm its subject proves nothing, and this is the assertion
 * that says so at PR time instead of leaving it to be believed.
 */
type NeedsDisarm = { define?: string; inject: string };
type DisarmableGate = { jobId: string; workflow: string; needsDisarm: NeedsDisarm };

/**
 * GitHub's status-check functions. None of them makes a job SKIPPABLE.
 *
 * `always()` is the canonical cannot-skip condition, and `success()` /
 * `failure()` / `cancelled()` are decided by the run's state, not by the event.
 * A round-1 version of this check listed the two spellings `true` and
 * `${{ true }}` — a two-token blocklist, which `always()` walks straight through.
 * MEASURED on the real `ci.yml`: rewriting `docs-drift-reminder`'s `if:` to
 * `always()` left the spec green while the prover kept scoring five gates as
 * PROVED, even though `needs: <always() job>` skips nothing.
 */
const STATUS_FUNCTION = /\b(?:always|success|failure|cancelled)\s*\(\s*\)/;

/**
 * A context whose value can differ between runs, so an expression mentioning one
 * CAN be false. This is the ALLOWLIST half: an expression that references none of
 * them (`1 == 1`, `'a' != 'b'`, a bare function call, anything unrecognised)
 * FAILS rather than passing, because a check that waves through what it does not
 * understand is how the next spelling gets in.
 */
const FALSIFIABLE_CONTEXT = /\b(?:github|needs|inputs|env|vars|matrix|steps|job|runner|secrets)\./;

/**
 * Can the job this disarm points at actually SKIP? Fail-closed.
 *
 * The issue's criterion is "an existing job that carries a skip condition", and
 * the only honest reading of "skip condition" is an expression that can evaluate
 * false in the run the gate is being proved for.
 */
function skipConditionProblem(job: Record<string, unknown>, target: string): string | null {
  if (!('if' in job)) {
    return `\`needs: ${target}\` names a job with no \`if:\` — a job that always runs cannot skip, so nothing about the gate changes`;
  }
  const raw = job.if;
  // `if: false` is a permanent skip, which IS skippable. `if: true` is not.
  if (typeof raw === 'boolean') {
    return raw
      ? `\`needs: ${target}\` names a job whose \`if:\` is the literal \`true\` — that is not a skip condition`
      : null;
  }
  if (typeof raw !== 'string') {
    return `\`needs: ${target}\` names a job whose \`if:\` is neither a string nor a boolean (${JSON.stringify(raw)}) — this check fails closed on what it cannot read`;
  }
  // `${{ … }}` is optional around an `if:` expression and changes nothing about
  // what it evaluates, so it is stripped rather than pattern-matched around.
  const expr = raw
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .trim();
  if (STATUS_FUNCTION.test(expr)) {
    return `\`needs: ${target}\` names a job whose \`if:\` uses a status function (${JSON.stringify(raw)}) — \`always()\`/\`success()\`/\`failure()\`/\`cancelled()\` are not skip conditions, so this "disarm" would red the guard without ever skipping the gate`;
  }
  if (!FALSIFIABLE_CONTEXT.test(expr)) {
    return `\`needs: ${target}\` names a job whose \`if:\` (${JSON.stringify(raw)}) references no context that can be false — accepted: an expression mentioning one of github./needs./inputs./env./vars./matrix./steps./job./runner./secrets. This check fails closed: an expression it cannot recognise is NOT assumed skippable`;
  }
  return null;
}

/** Everything wrong with a gate's `needs:` disarm. Empty means it really disarms. */
function auditNeedsDisarm(workflowText: string, gate: DisarmableGate): string[] {
  const problems: string[] = [];
  const anchor = jobAnchor(gate.jobId);
  const occurrences = workflowText.split(anchor).length - 1;
  if (occurrences !== 1) {
    // The harness refuses this too, but refusing at run time means the prover
    // dies mid-board; saying it here means the PR does.
    problems.push(`the job anchor for \`${gate.jobId}\` occurs ${occurrences} times, not once`);
    return problems;
  }
  const mutated = workflowText.replace(anchor, () =>
    disarmReplacement(gate.jobId, gate.needsDisarm),
  );

  let doc: unknown;
  try {
    doc = parse(mutated);
  } catch (err) {
    // A disarm whose `define:` is malformed YAML reds every guard it touches,
    // for a reason that has nothing to do with the gate.
    problems.push(`the disarmed workflow does not parse: ${(err as Error).message}`);
    return problems;
  }
  const jobs = (doc as { jobs?: Record<string, Record<string, unknown>> } | null)?.jobs;
  if (!jobs || typeof jobs !== 'object') {
    problems.push('the disarmed workflow has no `jobs:` mapping');
    return problems;
  }

  const needs = jobs[gate.jobId]?.needs;
  const targets = typeof needs === 'string' ? [needs] : Array.isArray(needs) ? needs : [];
  if (targets.length === 0) {
    problems.push(
      `the disarm injected no \`needs:\` onto \`${gate.jobId}\` — whatever it reds, it is not this`,
    );
    return problems;
  }

  for (const target of targets) {
    if (typeof target !== 'string') {
      problems.push(`\`needs:\` on \`${gate.jobId}\` has a non-string entry`);
      continue;
    }
    if (target === gate.jobId) {
      problems.push(
        `\`needs: ${target}\` points the gate at ITSELF — that is a cycle, not a disarm`,
      );
      continue;
    }
    const job = jobs[target];
    if (job === undefined || job === null || typeof job !== 'object') {
      problems.push(
        `\`needs: ${target}\` names a job that does NOT exist in ${gate.workflow} (define it, or point at one that does) — the guard would red on "is not defined in this workflow", which proves the audit rejects an invalid workflow, not that it detects a disarm`,
      );
      continue;
    }
    const skip = skipConditionProblem(job, target);
    if (skip) problems.push(skip);
    // The cycle half, walked with the SAME closure walk the audit uses. A target
    // that `needs:` the gate back is not a workflow GitHub will run.
    const closure = auditJobCanNotSkip(jobs, target, []);
    if (closure.includes(gate.jobId)) {
      problems.push(
        `\`needs: ${target}\` is a CYCLE — \`${target}\` needs \`${gate.jobId}\` back (closure: ${closure.join(' -> ')})`,
      );
    }
  }
  return problems;
}

describe('#690 every `needs:` disarm names a job that exists and can skip', () => {
  it.each(GATES)('$jobId — its `needs:` disarm really disarms', (gate) => {
    const text = readFileSync(resolve(REPO_ROOT, gate.workflow), 'utf8');
    const problems = auditNeedsDisarm(text, gate as unknown as DisarmableGate);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  /**
   * The other half. Every assertion above is "the real disarms are fine", which
   * a check that can only answer yes would also satisfy — the exact blindness
   * `blocking-gate-helper.test.ts` exists to close for the audit engine. So each
   * way a disarm can red for the wrong reason gets a synthetic workflow proving
   * the check SAYS SO. Fixtures are written whole; nothing here depends on a
   * substitution having succeeded.
   */
  const FIXTURE = [
    'name: fixture',
    'on:',
    '  pull_request:',
    'jobs:',
    '  the-gate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: run-the-gate',
    '  can-skip:',
    "    if: github.event_name == 'pull_request'",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: true',
    '  always-runs:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: true',
    '  needs-the-gate:',
    "    if: github.event_name == 'schedule'",
    '    needs: [the-gate]',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: true',
    '',
  ].join('\n');

  const auditInject = (inject: string, define?: string) =>
    auditNeedsDisarm(FIXTURE, {
      jobId: 'the-gate',
      workflow: 'fixture.yml',
      needsDisarm: { define, inject },
    }).join('\n');

  it('NEGATIVE CONTROL: a real skippable target has no finding', () => {
    expect(auditInject('    needs: can-skip')).toBe('');
  });

  it('THE CASE THAT MATTERS: a NONEXISTENT job is a finding', () => {
    expect(auditInject('    needs: no-such-job')).toMatch(/does NOT exist/);
  });

  it('a target with no `if:` at all is a finding', () => {
    expect(auditInject('    needs: always-runs')).toMatch(/no `if:`/);
  });

  /** A job with an arbitrary `if:`, so each forbidden spelling can be pointed at. */
  const withIf = (expr: string) =>
    `  probe-target:\n    if: ${expr}\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n`;
  const auditIf = (expr: string) => auditInject('    needs: probe-target', withIf(expr));

  it('THE CASE THAT MATTERS: `always()` is not a skip condition, bare and wrapped', () => {
    // Round 1's blocklist knew `true` and `${{ true }}` only, so the canonical
    // GitHub cannot-skip condition walked through it — and a one-word edit to
    // ci.yml would have voided five gate proofs while the prover still printed
    // PROVED.
    expect(auditIf('always()')).toMatch(/status function/);
    expect(auditIf('${{ always() }}')).toMatch(/status function/);
  });

  it('the other status functions are refused too — `success()` and `!cancelled()`', () => {
    expect(auditIf('success()')).toMatch(/status function/);
    // QUOTED in the fixture because a bare leading `!` is a YAML TAG, not a
    // negation — an unquoted `if: !cancelled()` does not parse, which would have
    // made this assertion pass for a reason unrelated to what it tests.
    expect(auditIf('"!cancelled()"')).toMatch(/status function/);
  });

  it('a constantly-true expression is refused, literal or arithmetic', () => {
    expect(auditIf('true')).toMatch(/literal `true`/);
    expect(auditIf('${{ 1 == 1 }}')).toMatch(/references no context that can be false/);
  });

  it('an UNRECOGNISED expression FAILS — the check does not wave through what it cannot read', () => {
    // The allowlist half. Both of these are things nobody enumerated; neither is
    // assumed skippable, which is the property a blocklist can never have.
    // Quoted in the fixture: a plain YAML scalar cannot start with `'`, and
    // `${{ … }}` carrying quotes is safest written as a quoted scalar too. A
    // fixture that fails to parse would satisfy nothing about the rule.
    expect(auditIf("\"'a' != 'b'\"")).toMatch(/references no context that can be false/);
    expect(auditIf('"${{ fromJSON(\'true\') }}"')).toMatch(
      /references no context that can be false/,
    );
  });

  it('NEGATIVE CONTROLS: real skip conditions pass, in three shapes', () => {
    // A guard that reds on a CORRECT disarm target is how "edit the guard"
    // becomes the way back to green, so the accepted forms are asserted too.
    expect(auditIf("github.event_name == 'pull_request'")).toBe('');
    expect(auditIf("${{ needs.build.result == 'success' }}")).toBe('');
    // `if: false` is a permanent skip — unusual, but genuinely skippable.
    expect(auditIf('false')).toBe('');
  });

  it('a CYCLE is a finding — an invalid workflow reds for its own reason', () => {
    expect(auditInject('    needs: needs-the-gate')).toMatch(/CYCLE/);
  });

  it('pointing the gate at ITSELF is a finding', () => {
    expect(auditInject('    needs: the-gate')).toMatch(/ITSELF/);
  });

  it('an injection that is not a `needs:` at all is a finding', () => {
    expect(auditInject('    "if": false')).toMatch(/injected no `needs:`/);
  });

  it('a `define:` that is malformed YAML is a finding, never a pass', () => {
    expect(auditInject('    needs: broken', '  broken:\n   if: [unclosed\n')).toMatch(
      /does not parse/,
    );
  });

  /**
   * The sharing has to be REAL, and that means the CALL SITE (#690 r2).
   *
   * Round 1 asserted `disarmReplacement(` appeared somewhere in the prover and
   * that the literal `disarm.define` did not. Neither says anything about what
   * `mutate()` is actually handed. MEASURED: an inline rebuild that renames the
   * alias and drops `define` keeps all of this file green — while the prover then
   * injects `needs: proof-skippable` WITHOUT defining that job, which is exactly
   * the nonexistent-target defect this whole block exists to close. So the
   * assertion is anchored on the third argument of the `mutate(snap, anchor, …)`
   * call, and on the import that makes the name mean the shared function rather
   * than a local one.
   */
  const proverSource = () =>
    readFileSync(resolve(REPO_ROOT, 'scripts/mutation-prove-ci-blocking-gates.mjs'), 'utf8');

  it("the PROVER's `mutate()` is handed `disarmReplacement(...)` itself", () => {
    // Code-only, so an identifier surviving in a comment does not satisfy it.
    expect(blankNonCode(proverSource())).toMatch(
      /\bmutate\(\s*snap\s*,\s*anchor\s*,\s*disarmReplacement\(/,
    );
  });

  it('and that name is the SHARED one — imported, not a local look-alike', () => {
    // The call-site anchor alone is satisfied by `function disarmReplacement()`
    // declared in the prover, which is the copy-instead-of-share failure with the
    // right spelling. Literals intact, because the module specifier IS a literal.
    const code = codeWithLiterals(proverSource());
    expect(code).toMatch(
      /import\s*\{[^}]*\bdisarmReplacement\b[^}]*\}\s*from\s*'\.\/lib\/ci-blocking-gate-proof\.mjs'/,
    );
    expect(
      /\b(?:function|const|let|var)\s+disarmReplacement\b/.test(code),
      'the prover defines its own disarmReplacement — that is a fork, not sharing',
    ).toBe(false);
  });
});
