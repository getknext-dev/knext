import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * #1406 (rev-ci-1390-1396 round 2): none of the 9 nightly-alert jobs that
 * call `node scripts/nightly-alert-issue.mjs` (8 as `nightly-red-alert`,
 * plus `vinext-red-alert` in `compat-vinext.yml`) carries an
 * `actions/checkout` step of its OWN. A GitHub Actions job starts on a bare
 * runner with no repo checked out by default — nothing upstream shares a
 * checkout across jobs — so `node scripts/nightly-alert-issue.mjs` always
 * failed with `MODULE_NOT_FOUND`, and no alert was ever filed for any red
 * night on any of these 9 workflows.
 *
 * This is a SCAN, not an enumerated list of the 9 known offenders: it parses
 * every job in every workflow and, for any job whose steps EXECUTE a
 * `scripts/*` file, requires an earlier step in that same job to provide the
 * repo — either `actions/checkout`, or (the OTHER pattern this repo actually
 * uses, in `test-e2e-deploy.yml`/`compat-vinext.yml`'s `deploy-tests`) a
 * `tar x...f` extraction of a downloaded workspace tarball. A future job
 * added to any workflow that shells out to a repo script with neither trips
 * this immediately.
 *
 * Two false-positive classes measured against the real tree and closed
 * deliberately, not assumed away:
 *   1. `scripts/*.mjs` mentioned in a bash COMMENT or inside a quoted
 *      message STRING (`test-e2e-deploy.yml`'s `nightly-red-alert` names
 *      `scripts/e2e-bytecode-liveness.mjs` in prose, never executes it) —
 *      the detector requires an EXECUTION VERB (`node`/`bash`/`sh`/`python3`)
 *      or a `./scripts/...` direct-exec form immediately before the path,
 *      not a bare substring match.
 *   2. `deploy-tests` in `compat-vinext.yml`/`test-e2e-deploy.yml` never
 *      checks out — it downloads a pre-built workspace tarball and
 *      `tar xzf`s it (`Unpack workspace tarball`), which is this repo's
 *      established alternative to checkout for that job shape. Treated as
 *      checkout-equivalent, not exempted from the scan by name.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows');

type YamlStep = { name?: unknown; run?: unknown; uses?: unknown } & Record<string, unknown>;
type YamlJob = { steps?: unknown } & Record<string, unknown>;
type YamlDoc = { jobs?: Record<string, YamlJob> };

/** Requires an execution verb or `./` immediately before the path — not a bare mention. */
const SCRIPT_EXEC_RE =
  /\b(?:node|bash|sh|python3?)\s+scripts\/[\w./-]+\.(?:mjs|sh|js|ts)\b|(?:^|\s)\.\/scripts\/[\w./-]+\.(?:mjs|sh|js|ts)\b/m;
const CHECKOUT_USES_RE = /^actions\/checkout@/;
/** This repo's other established way to make the repo tree available to a job. */
const TAR_EXTRACT_RE = /\btar\s+x[a-z]*f\b/;

function stripBashCommentLines(text: string): string {
  return text.replace(/^\s*#.*$/gm, '');
}

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

function loadJobs(file: string): Record<string, YamlJob> {
  const doc = parse(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8')) as YamlDoc | null;
  return doc?.jobs ?? {};
}

function stepsOf(job: YamlJob): YamlStep[] {
  return Array.isArray(job.steps) ? (job.steps as YamlStep[]) : [];
}

/** True if the step's `run:` actually EXECUTES a `scripts/*` file (comment-stripped). */
function runsRepoScript(step: YamlStep): boolean {
  return typeof step.run === 'string' && SCRIPT_EXEC_RE.test(stripBashCommentLines(step.run));
}

/** True if the step checks out the repo via `actions/checkout`. */
function isCheckoutStep(step: YamlStep): boolean {
  return typeof step.uses === 'string' && CHECKOUT_USES_RE.test(step.uses);
}

/** True if the step extracts a downloaded workspace tarball — this repo's other pattern. */
function isTarExtractStep(step: YamlStep): boolean {
  return typeof step.run === 'string' && TAR_EXTRACT_RE.test(step.run);
}

function providesRepoContent(step: YamlStep): boolean {
  return isCheckoutStep(step) || isTarExtractStep(step);
}

interface Finding {
  file: string;
  job: string;
  scriptStepLabel: string;
}

/**
 * For every job in every workflow, find any step that executes a repo script
 * with no EARLIER repo-providing step (checkout or tar-extract) in the same
 * job.
 */
function findMissingCheckoutBeforeScriptSteps(): Finding[] {
  const findings: Finding[] = [];
  for (const file of listWorkflowFiles()) {
    const jobs = loadJobs(file);
    for (const [jobName, job] of Object.entries(jobs)) {
      const steps = stepsOf(job);
      let sawRepoContent = false;
      steps.forEach((step, index) => {
        if (providesRepoContent(step)) {
          sawRepoContent = true;
          return;
        }
        if (runsRepoScript(step) && !sawRepoContent) {
          const label = typeof step.name === 'string' ? step.name : `step #${index + 1}`;
          findings.push({ file, job: jobName, scriptStepLabel: label });
        }
      });
    }
  }
  return findings;
}

describe('#1406 — every job that executes a repo script provides the repo first', () => {
  it('non-vacuity: the scanner recognises a real script-execution step (positive control)', () => {
    // resolve-action-pins in action-pin-resolution-nightly.yml runs
    // `node scripts/verify-action-pins.mjs` — prove the detector fires on a
    // known-good case before trusting the negative assertion below.
    const jobs = loadJobs('action-pin-resolution-nightly.yml');
    const steps = stepsOf(jobs['resolve-action-pins']);
    const scriptIndex = steps.findIndex(runsRepoScript);
    expect(scriptIndex).toBeGreaterThanOrEqual(0);
    const checkoutIndex = steps.findIndex(isCheckoutStep);
    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(checkoutIndex).toBeLessThan(scriptIndex);
  });

  it('non-vacuity: a bare mention of a scripts/ path in prose (no execution verb) does NOT trip the detector', () => {
    const mentionOnly: YamlStep = {
      run: 'restart_cause="see scripts/e2e-bytecode-liveness.mjs for detail"',
    };
    expect(runsRepoScript(mentionOnly)).toBe(false);
    const commentOnly: YamlStep = { run: '# node scripts/never-actually-run.mjs\necho hi' };
    expect(runsRepoScript(commentOnly)).toBe(false);
  });

  it('non-vacuity: a tar-extract step counts as repo-providing (the deploy-tests pattern)', () => {
    const jobs = loadJobs('test-e2e-deploy.yml');
    const steps = stepsOf(jobs['deploy-tests']);
    expect(steps.some(isTarExtractStep)).toBe(true);
  });

  it('no job executes a scripts/ file with no earlier checkout or tar-extract step', () => {
    const findings = findMissingCheckoutBeforeScriptSteps();
    const summary = findings
      .map((f) => `${f.file}: job "${f.job}" step "${f.scriptStepLabel}"`)
      .join('\n');
    expect(
      findings,
      `job(s) execute a repo script with no prior repo-providing step:\n${summary}`,
    ).toEqual([]);
  });

  it('covers all 9 nightly-alert jobs by name (documented floor, not the whole proof)', () => {
    const expected: Array<{ file: string; job: string }> = [
      { file: 'action-pin-resolution-nightly.yml', job: 'nightly-red-alert' },
      { file: 'anonymous-install-nightly.yml', job: 'nightly-red-alert' },
      { file: 'docs-closure-nightly.yml', job: 'nightly-red-alert' },
      { file: 'file-manager-platform-e2e-nightly.yml', job: 'nightly-red-alert' },
      { file: 'image-pin-resolution-nightly.yml', job: 'nightly-red-alert' },
      { file: 'mutation-prover-nightly.yml', job: 'nightly-red-alert' },
      { file: 'retracted-figure-resolution-nightly.yml', job: 'nightly-red-alert' },
      { file: 'scaffold-install-nightly.yml', job: 'nightly-red-alert' },
      { file: 'compat-vinext.yml', job: 'vinext-red-alert' },
    ];
    for (const { file, job } of expected) {
      const jobs = loadJobs(file);
      const jobDef = jobs[job];
      expect(jobDef, `${file} no longer has a job named "${job}"`).toBeTruthy();
      const steps = stepsOf(jobDef);
      const repoIndex = steps.findIndex(providesRepoContent);
      const scriptIndex = steps.findIndex(runsRepoScript);
      expect(
        scriptIndex,
        `${file}/${job}: no step executes a scripts/ file anymore?`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        repoIndex,
        `${file}/${job}: no checkout/tar-extract step found`,
      ).toBeGreaterThanOrEqual(0);
      expect(repoIndex, `${file}/${job}: checkout must come BEFORE the scripts/ step`).toBeLessThan(
        scriptIndex,
      );
    }
  });
});
