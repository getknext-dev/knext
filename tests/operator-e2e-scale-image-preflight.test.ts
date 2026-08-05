import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * GUARD TESTS for the e2e_scale lane's SCALE_TEST_IMAGE precondition (#659).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `test/e2e/image_prewarm_e2e_test.go` is the only guard that would have caught
 * the #471 glibc-helper regression end to end (a prewarm DaemonSet that
 * CrashLoopBackOffs on every node while `Ready` stays `True`). It had never run:
 * the nightly resolved `inputs.scale_test_image || vars.SCALE_TEST_IMAGE`, and an
 * empty result only logged a `::warning::` and set `skip=true`, which an `if:` on
 * the run step consumed. The job then reported SUCCESS in ~90 seconds having
 * executed nothing — green by skip, the third instance of that shape in this repo
 * (#408, #448). ADR-0037's own amendment states the conclusion: *a spec that
 * cannot run is not a guard.*
 *
 * WHY FAILING IS SAFE HERE — established, not assumed:
 *   - `vars.SCALE_TEST_IMAGE` is unset (`gh api repos/getknext-dev/knext/actions/
 *     variables` -> total_count 0), and the 2026-08-05 nightly carried the
 *     `::warning::No SCALE_TEST_IMAGE provided` annotation, so nothing resolves it
 *     at org level either.
 *   - the workflow has NO `pull_request`/`push` trigger. It runs on `schedule` and
 *     `workflow_dispatch` only, so a fail-closed precondition cannot red PR CI.
 * Both facts are asserted below, because the safety of the fail depends on them
 * and a later trigger addition must be a deliberate, visible decision.
 *
 * BOTH HALVES. Converting the skip into an `exit 1` is not sufficient on its own:
 * the scale job carries `continue-on-error: true` (real Knative scale-timing
 * flake on shared runners), which would swallow that failure and report success
 * exactly as the skip did. So the precondition lives in its OWN job that carries
 * no `continue-on-error` and no `if:`, and the scale job `needs:` it. These tests
 * assert the failure happens AND that nothing silently opts it out.
 *
 * The behavioural half EXECUTES the workflow's own `run:` script rather than
 * grepping it, which is why the script must be free of `${{ }}` expressions (the
 * image is injected via `env:`) — asserted here too.
 */

const WORKFLOW_PATH = resolve(import.meta.dirname, '../.github/workflows/operator-e2e-nightly.yml');

/** The job that must fail — loudly — when no scale image is resolvable. */
const PREFLIGHT_JOB = 'scale-image-preflight';
/** The heavy suite job that runs the e2e_scale specs (image prewarm included). */
const SCALE_JOB = 'scale-to-zero-cache';

const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML has no schema type here.
const workflow = parseYaml(workflowText) as any;

/** The preflight job's single `run:` step, located by the script it carries. */
// biome-ignore lint/suspicious/noExplicitAny: see above.
function preflightRunSteps(): any[] {
  const job = workflow.jobs?.[PREFLIGHT_JOB];
  expect(job, `workflow has no \`${PREFLIGHT_JOB}\` job`).toBeTruthy();
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  return (job.steps ?? []).filter((s: any) => typeof s.run === 'string');
}

/**
 * Runs the preflight job's shell script exactly as the runner would: bash, the
 * step's own `env:` names, a real GITHUB_OUTPUT file. Returns the exit status,
 * the combined output, and whatever the script wrote to GITHUB_OUTPUT.
 */
function runPreflightScript(env: Record<string, string>): {
  status: number;
  output: string;
  githubOutput: string;
} {
  const steps = preflightRunSteps();
  expect(steps.length, 'preflight job must carry exactly one run step').toBe(1);
  const script = steps[0].run as string;

  const dir = mkdtempSync(join(tmpdir(), 'knext-preflight-'));
  const scriptPath = join(dir, 'preflight.sh');
  const outPath = join(dir, 'github-output');
  writeFileSync(scriptPath, script);
  writeFileSync(outPath, '');

  try {
    execFileSync('bash', [scriptPath], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: outPath, ...env },
    });
    return { status: 0, output: '', githubOutput: readFileSync(outPath, 'utf8') };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      githubOutput: readFileSync(outPath, 'utf8'),
    };
  }
}

/** The env var names the preflight step feeds its script (input + repo var). */
function preflightEnvNames(): { input: string; variable: string } {
  const env = (preflightRunSteps()[0].env ?? {}) as Record<string, string>;
  const entries = Object.entries(env);
  const input = entries.find(([, v]) => v.includes('inputs.scale_test_image'))?.[0];
  const variable = entries.find(([, v]) => v.includes('vars.SCALE_TEST_IMAGE'))?.[0];
  expect(input, 'preflight must read the workflow_dispatch input via env:').toBeTruthy();
  expect(variable, 'preflight must read vars.SCALE_TEST_IMAGE via env:').toBeTruthy();
  return { input: input as string, variable: variable as string };
}

describe('e2e_scale image precondition FAILS rather than skips (#659)', () => {
  it('exits non-zero, naming the variable, when neither input nor repo var is set', () => {
    const { input, variable } = preflightEnvNames();
    const res = runPreflightScript({ [input]: '', [variable]: '' });

    expect(
      res.status,
      'an unresolvable SCALE_TEST_IMAGE must FAIL the lane — a spec that cannot run is not a guard',
    ).not.toBe(0);
    expect(res.output).toContain('SCALE_TEST_IMAGE');
    expect(res.githubOutput, 'no skip flag may be emitted — skipping is the defect').not.toMatch(
      /skip\s*=\s*true/,
    );
  });

  it('rejects the deliberately-unpullable all-zeros placeholder digest', () => {
    // The in-code default in test/e2e/scale_*_test.go. If it ever reaches the
    // cluster the ksvc ErrImagePulls; accepting it here would recreate a lane
    // that runs but proves nothing.
    const placeholder = `dev.local/file-manager@sha256:${'0'.repeat(64)}`;
    const { input, variable } = preflightEnvNames();
    const res = runPreflightScript({ [input]: '', [variable]: placeholder });

    expect(res.status, 'the placeholder digest must FAIL the lane').not.toBe(0);
  });

  it('resolves and exports a real image, with the dispatch input taking precedence', () => {
    const { input, variable } = preflightEnvNames();
    const fromVar = 'ghcr.io/getknext-dev/file-manager@sha256:' + 'a'.repeat(64);
    const fromInput = 'ghcr.io/getknext-dev/file-manager@sha256:' + 'b'.repeat(64);

    const varOnly = runPreflightScript({ [input]: '', [variable]: fromVar });
    expect(varOnly.status, 'a resolvable image must not fail the lane').toBe(0);
    expect(varOnly.githubOutput).toContain(`image=${fromVar}`);

    const both = runPreflightScript({ [input]: fromInput, [variable]: fromVar });
    expect(both.status).toBe(0);
    expect(both.githubOutput, 'the dispatch input must win over the repo variable').toContain(
      `image=${fromInput}`,
    );
  });

  it('keeps the preflight script expression-free so it is testable as written', () => {
    const script = preflightRunSteps()[0].run as string;
    expect(
      script,
      'a GitHub expression in the script would make this suite test a different program than CI runs',
    ).not.toContain('${{');
  });
});

describe('nothing silently opts the precondition out (#659 / #661)', () => {
  it('runs the precondition in a job that carries no continue-on-error', () => {
    const job = workflow.jobs[PREFLIGHT_JOB];
    // Any form — literal true/false OR the `${{ }}` expression form (#661) — is
    // rejected: a precondition whose failure is tolerated is a skip with extra
    // steps.
    expect(
      'continue-on-error' in job,
      'continue-on-error on the preflight job would swallow the failure, recreating the green-by-skip defect',
    ).toBe(false);
    for (const step of job.steps ?? []) {
      expect('continue-on-error' in step, 'a step-level continue-on-error disarms it too').toBe(
        false,
      );
    }
  });

  it('gives the preflight job no if: condition and no upstream needs:', () => {
    const job = workflow.jobs[PREFLIGHT_JOB];
    // Parsed YAML, not a text anchor: `"if":` (a quoted key, #661 hole 1) is the
    // same key here and cannot evade this.
    expect('if' in job, 'a job-level if: can disable the precondition entirely').toBe(false);
    for (const step of job.steps ?? []) {
      expect('if' in step, 'a step-level if: can skip the precondition').toBe(false);
    }
    // A job that `needs:` a skipped job is itself skipped, and a skipped job does
    // not fail the workflow (#661 hole 2).
    expect(
      'needs' in job,
      'the preflight must not depend on another job, or a skip upstream disarms it',
    ).toBe(false);
  });

  it('wires the scale suite to the preflight job as its only image source', () => {
    const scale = workflow.jobs[SCALE_JOB];
    const needs = Array.isArray(scale.needs) ? scale.needs : [scale.needs];
    expect(needs, 'the scale suite must depend on the precondition').toContain(PREFLIGHT_JOB);

    const runStep = (scale.steps ?? []).find(
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      (s: any) => typeof s.run === 'string' && s.run.includes('test-e2e-scale'),
    );
    expect(runStep, 'no step runs `make test-e2e-scale`').toBeTruthy();
    expect(
      runStep.env?.SCALE_TEST_IMAGE,
      'the suite must consume the preflight output, not re-resolve (and re-skip) the image itself',
    ).toContain(`needs.${PREFLIGHT_JOB}.outputs.image`);
    expect(
      'if' in runStep,
      'an if: on the suite step is how the skip was implemented — it must not come back',
    ).toBe(false);
  });

  it('exports the resolved image from the preflight job', () => {
    const outputs = workflow.jobs[PREFLIGHT_JOB].outputs ?? {};
    expect(
      Object.values(outputs).join(' '),
      'the preflight must export the resolved image for the suite job',
    ).toContain('outputs.image');
  });

  it('emits no ::warning:: annotation from any script in the workflow', () => {
    // A warning annotation is precisely what let every nightly read as green
    // while the lane executed nothing. Failing loudly replaces it; it must not
    // sit alongside. Scanned over every `run:` in the file (not just the
    // preflight's) so the pattern cannot reappear in a sibling job.
    // biome-ignore lint/suspicious/noExplicitAny: workflow YAML has no schema type here.
    const scripts = Object.values(workflow.jobs as Record<string, any>).flatMap((job) =>
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      (job.steps ?? []).filter((s: any) => typeof s.run === 'string').map((s: any) => s.run),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script, 'a ::warning:: is how a missing precondition stayed green').not.toContain(
        '::warning::',
      );
    }
  });
});

describe('the lane is scheduled where it can run, and only there (#659)', () => {
  it('still runs on the nightly schedule', () => {
    expect(
      workflow.on?.schedule,
      'a fail-closed precondition on a lane that is never scheduled proves nothing',
    ).toBeTruthy();
  });

  it('is not wired to any PR/push trigger, which is what makes failing safe', () => {
    // If this ever changes, the fail-closed precondition would red every PR —
    // strictly worse than the skip. Adding a trigger must therefore be a
    // deliberate change that turns this test red first.
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });
});
