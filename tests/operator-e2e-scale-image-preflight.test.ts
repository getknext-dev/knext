import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
 * the scale job tolerates real Knative scale-timing flake (a `continue-on-error`
 * scoped to its suite STEP — #670 cr#3 moved it off the job so it cannot swallow
 * image login/pull/load failures), which would swallow the precondition failure
 * and report success exactly as the skip did. So the precondition lives in its
 * OWN job that carries no `continue-on-error` and no `if:`, and the scale job
 * `needs:` it. These tests assert the failure happens AND that nothing silently
 * opts it out.
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

/**
 * The preflight job's SHAPE-GUARD `run:` step — the verbatim bash that validates
 * the resolved reference (`@sha256:<64 hex>`, not the all-zeros placeholder, no
 * embedded newline) and exports `image=`. Located by the unique `placeholder_digest`
 * anchor rather than by position, because #670 added sibling run steps to the job
 * (the GHCR resolver and the cosign verify). This is the program the behavioural
 * tests below execute, so it must stay expression-free.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above.
function preflightRunSteps(): any[] {
  const job = workflow.jobs?.[PREFLIGHT_JOB];
  expect(job, `workflow has no \`${PREFLIGHT_JOB}\` job`).toBeTruthy();
  const guard = (job.steps ?? []).filter(
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    (s: any) => typeof s.run === 'string' && s.run.includes('placeholder_digest'),
  );
  expect(guard.length, 'exactly one preflight step carries the shape-guard script').toBe(1);
  return guard;
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The env var names the preflight step feeds its script (input + repo var). */
function preflightEnvNames(): { input: string; variable: string } {
  const env = (preflightRunSteps()[0].env ?? {}) as Record<string, string>;
  const entries = Object.entries(env);
  const input = entries.find(([, v]) => v.includes('inputs.scale_test_image'))?.[0];
  // #670: the guard step now reads its candidate from the run-time GHCR resolver
  // step (`steps.resolve.outputs.resolved`) instead of the unset repo variable
  // `vars.SCALE_TEST_IMAGE` that starved the lane (#659).
  const variable = entries.find(([, v]) => v.includes('steps.resolve.outputs.resolved'))?.[0];
  expect(input, 'preflight must read the workflow_dispatch input via env:').toBeTruthy();
  expect(variable, 'preflight guard must read the resolved image via env:').toBeTruthy();
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

  it('rejects every value that is not a digest-pinned reference', () => {
    // The all-zeros check above enumerates ONE bad value. A MIS-SET
    // vars.SCALE_TEST_IMAGE — wrong shape, `:latest`, stray whitespace — used to
    // pass the preflight and die later inside scale-to-zero-cache on
    // ErrImagePull or the operator's `:latest` rejection, where
    // `continue-on-error: true` SWALLOWS it and the workflow reports success
    // having proven nothing. That is #659's own failure re-entering by another
    // door, so the check is a positive scan (`@sha256:` + 64 hex) rather than a
    // blocklist, which also enforces the repo's digest-pin / reject-`:latest`
    // rule at the point the value is first accepted.
    const { input, variable } = preflightEnvNames();
    const rejected: Array<[string, string]> = [
      ['a mutable :latest tag', 'ghcr.io/getknext-dev/file-manager:latest'],
      ['a bare mutable tag', 'ghcr.io/getknext-dev/file-manager:v1.2.3'],
      ['no tag and no digest', 'file-manager'],
      ['not an image reference at all', 'not-an-image'],
      ['whitespace only', '   '],
      ['a truncated digest', `ghcr.io/getknext-dev/file-manager@sha256:${'a'.repeat(40)}`],
      ['an over-long digest', `ghcr.io/getknext-dev/file-manager@sha256:${'a'.repeat(65)}`],
      ['a non-hex digest', `ghcr.io/getknext-dev/file-manager@sha256:${'g'.repeat(64)}`],
      ['a non-sha256 digest algorithm', `ghcr.io/getknext-dev/file-manager@md5:${'a'.repeat(64)}`],
      ['an internal space', `ghcr.io/get knext/file-manager@sha256:${'a'.repeat(64)}`],
    ];

    for (const [label, value] of rejected) {
      const res = runPreflightScript({ [input]: '', [variable]: value });
      expect(res.status, `${label} must FAIL the lane, not reach the cluster`).not.toBe(0);
      expect(res.githubOutput, `${label} must never be exported as an image`).not.toContain(
        'image=',
      );
    }
  });

  it('refuses a multi-line value instead of injecting extra step outputs', () => {
    // `echo "image=$img" >> "$GITHUB_OUTPUT"` with an unvalidated value is
    // arbitrary step-output injection: a multi-line workflow_dispatch input
    // writes `image=…`, `image=evil`, `foo=bar` and the LAST assignment wins.
    // The shape check closes it because a valid reference contains no newline.
    const { input, variable } = preflightEnvNames();
    const injected = `ghcr.io/getknext-dev/file-manager@sha256:${'a'.repeat(64)}\nimage=evil\nfoo=bar`;

    const res = runPreflightScript({ [input]: injected, [variable]: '' });
    expect(res.status, 'a multi-line image reference must FAIL, not be exported').not.toBe(0);
    expect(res.githubOutput, 'no attacker-chosen step output may be written').not.toContain('evil');
    expect(res.githubOutput).not.toContain('foo=bar');
  });

  it('does not let a whitespace-only dispatch input shadow a valid repo variable', () => {
    // A blank-but-not-empty input is a dispatch typo, not a deliberate override.
    // Treating it as "provided" would fail a lane the repo variable could run.
    const { input, variable } = preflightEnvNames();
    const img = `ghcr.io/getknext-dev/file-manager@sha256:${'d'.repeat(64)}`;

    const res = runPreflightScript({ [input]: '   \n', [variable]: img });
    expect(res.status, 'a blank input must fall through to vars.SCALE_TEST_IMAGE').toBe(0);
    expect(res.githubOutput.trim()).toBe(`image=${img}`);
  });

  it('accepts a digest-pinned image carrying stray surrounding whitespace, trimmed', () => {
    // A trailing newline in a repo variable is the likeliest honest mis-set; it
    // must be normalised, not rejected, and must not reach GITHUB_OUTPUT raw.
    const { input, variable } = preflightEnvNames();
    const img = `ghcr.io/getknext-dev/file-manager@sha256:${'c'.repeat(64)}`;

    const res = runPreflightScript({ [input]: '', [variable]: `  ${img}\n` });
    expect(res.status, 'surrounding whitespace is not a reason to fail the lane').toBe(0);
    expect(res.githubOutput.trim(), 'the exported image must be the trimmed value').toBe(
      `image=${img}`,
    );
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

  it('emits no ::warning:: annotation from the e2e_scale lane', () => {
    // A warning annotation is precisely what let every nightly read as green
    // while the lane executed nothing. Failing loudly replaces it; it must not
    // sit alongside. Scanned across BOTH jobs of the e2e_scale lane — the
    // preflight and the suite it gates — so the pattern cannot simply move one
    // job sideways and keep working.
    //
    // Scoped to those two jobs on purpose: the sibling cli-e2e / gc-e2e lanes
    // are not this guard's subject, and a legitimate warning there is not the
    // defect (#659) this pins. Widening it to the whole file would red this
    // suite for a change it has nothing to say about.
    for (const jobId of [PREFLIGHT_JOB, SCALE_JOB]) {
      const job = workflow.jobs[jobId];
      expect(job, `workflow has no \`${jobId}\` job`).toBeTruthy();
      const scripts = (job.steps ?? [])
        // biome-ignore lint/suspicious/noExplicitAny: workflow YAML has no schema type here.
        .filter((s: any) => typeof s.run === 'string')
        // biome-ignore lint/suspicious/noExplicitAny: see above.
        .map((s: any) => s.run);
      expect(scripts.length, `\`${jobId}\` has no run steps to scan`).toBeGreaterThan(0);
      for (const script of scripts) {
        expect(
          script,
          `a ::warning:: in \`${jobId}\` is how a missing precondition stayed green`,
        ).not.toContain('::warning::');
      }
    }
  });
});

describe('the run-time signed-digest resolver is wired in, fail-closed (#670)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML has no schema type here.
  function stepRunning(job: any, needle: string): any {
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    return (job.steps ?? []).find((s: any) => typeof s.run === 'string' && s.run.includes(needle));
  }

  it('resolves the image at run time instead of reading vars.SCALE_TEST_IMAGE', () => {
    const job = workflow.jobs[PREFLIGHT_JOB];
    const resolveStep = stepRunning(job, 'resolve-scale-test-image.mjs');
    expect(resolveStep, 'the preflight must invoke the run-time GHCR resolver').toBeTruthy();
    // The starvation source (#659) must be GONE: no job may READ the unset repo
    // variable that produced a permanently-red nightly. Asserted on the read
    // EXPRESSION, not on prose — comments may still name it to explain what
    // replaced it.
    expect(
      workflowText,
      'no job may read the unset vars.SCALE_TEST_IMAGE that starved the lane',
    ).not.toContain('${{ vars.SCALE_TEST_IMAGE }}');
  });

  it('holds packages:read to resolve/pull, but NOT variables:write', () => {
    const job = workflow.jobs[PREFLIGHT_JOB];
    const perms = job.permissions ?? {};
    expect(perms.packages, 'the resolver needs packages:read to list + pull the GHCR image').toBe(
      'read',
    );
    // Design option (b): resolve at run time rather than granting the signing
    // lane a standing variables:write to set the repo variable.
    expect('variables' in perms, 'no standing variables:write belongs on this lane').toBe(false);
  });

  it('confirms pullability + verifies the signature before handing off to the scale job', () => {
    const job = workflow.jobs[PREFLIGHT_JOB];
    // Pullability is proven inside the resolver program (checkPullable); the
    // cosign verify step is the cryptographic half. Both live here, where there
    // is no continue-on-error to swallow a failure — unlike the scale job.
    const cosignStep = stepRunning(job, 'cosign-verify.sh');
    expect(
      cosignStep,
      'the preflight must cryptographically verify the resolved signature',
    ).toBeTruthy();
  });
});

describe('the private image is authenticated end to end, no false-green (#670 cr#2/#3)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML has no schema type here.
  function steps(jobId: string): any[] {
    return workflow.jobs[jobId].steps ?? [];
  }
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  function usesAction(step: any, name: string): boolean {
    return typeof step.uses === 'string' && step.uses.includes(name);
  }
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  function runStep(jobId: string, needle: string): any {
    return steps(jobId).find((s) => typeof s.run === 'string' && s.run.includes(needle));
  }

  it('logs in to GHCR before cosign-verifying the PRIVATE file-manager package (#2)', () => {
    // file-manager is a private GHCR package: an anonymous `crane manifest`
    // UNAUTHORIZEDs, so cosign verify would fail without credentials — the
    // nightly would just move from red-at-variable-read to red-at-cosign.
    const s = steps(PREFLIGHT_JOB);
    const loginIdx = s.findIndex((step) => usesAction(step, 'docker/login-action'));
    const verifyIdx = s.findIndex(
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      (step: any) => typeof step.run === 'string' && step.run.includes('cosign-verify.sh'),
    );
    expect(
      loginIdx,
      'the preflight must log in to GHCR before verifying a private image',
    ).toBeGreaterThanOrEqual(0);
    expect(verifyIdx, 'the preflight must cosign-verify').toBeGreaterThanOrEqual(0);
    expect(loginIdx, 'GHCR login must come BEFORE cosign verify').toBeLessThan(verifyIdx);
  });

  it('parameterizes the cosign identity regexp to this repository (#4)', () => {
    const verifyStep = runStep(PREFLIGHT_JOB, 'cosign-verify.sh');
    const identity = verifyStep?.env?.IDENTITY_REGEXP ?? '';
    expect(
      identity,
      'the identity regexp must derive from github.repository, not a hardcoded owner/repo',
    ).toContain('${{ github.repository }}');
  });

  it('loads the resolved image INTO kind so the private pod can pull it (#3)', () => {
    // The consumer (`scale-to-zero-cache`) deploys to a kind cluster with NO
    // imagePullSecret. For a private image the pod would ErrImagePull. The
    // self-contained fix: pull on the runner (authenticated) and `kind load` it
    // into the node store, so the pod pulls locally (IfNotPresent) with no creds.
    const login = steps(SCALE_JOB).find((s) => usesAction(s, 'docker/login-action'));
    const pull = runStep(SCALE_JOB, 'docker pull');
    const load = runStep(SCALE_JOB, 'kind load docker-image');
    expect(
      login,
      'the scale job must authenticate to pull the private image on the runner',
    ).toBeTruthy();
    expect(pull, 'the scale job must pull the resolved image on the runner').toBeTruthy();
    expect(
      load,
      'the scale job must kind-load the image so the pod pulls from the node',
    ).toBeTruthy();
  });

  it('makes the image pull/load FAIL-LOUD — no continue-on-error swallows it (#3)', () => {
    // The #659 defect is a deterministic infra failure swallowed into a green.
    // A missing image load is NOT Knative scale-timing flake, so it must fail the
    // job. continue-on-error is therefore scoped to the flaky SUITE step only,
    // never the job — a job-level tolerance would swallow login/pull/load too.
    const job = workflow.jobs[SCALE_JOB];
    expect(
      'continue-on-error' in job,
      'a job-level continue-on-error would swallow the image load/pull failure into a false green',
    ).toBe(false);

    const load = runStep(SCALE_JOB, 'kind load docker-image');
    expect('continue-on-error' in load, 'the kind-load step must fail loud').toBe(false);
    const pull = runStep(SCALE_JOB, 'docker pull');
    expect('continue-on-error' in pull, 'the pull step must fail loud').toBe(false);

    const suite = runStep(SCALE_JOB, 'test-e2e-scale');
    expect(
      suite['continue-on-error'],
      'only the flaky Knative suite step stays tolerated (real scale-timing flake)',
    ).toBe(true);
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
