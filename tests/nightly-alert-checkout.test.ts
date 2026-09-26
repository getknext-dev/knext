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
 * `tar x...f` extraction of the tarball an earlier `download-artifact` step
 * in the same job fetched (resolved by artifact name to what the workflow's
 * `upload-artifact` step uploaded under it). A future job
 * added to any workflow that shells out to a repo script with neither trips
 * this immediately.
 *
 * Two false-positive classes measured against the real tree and closed
 * deliberately, not assumed away:
 *   1. `scripts/*.mjs` mentioned in a bash COMMENT or inside a quoted
 *      message STRING (`test-e2e-deploy.yml`'s `nightly-red-alert` names
 *      `scripts/e2e-bytecode-liveness.mjs` in prose, never executes it) —
 *      the detector requires an EXECUTION VERB (`node`/`bash`/`sh`/`python3`/
 *      `bun`/`bun run`/`tsx`), a `./` direct-exec form, or a workspace-prefixed
 *      path immediately before the (optionally `knext/`-prefixed) path — see
 *      `SCRIPT_EXEC_RE` — not a bare substring match.
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

/**
 * The workspace prefix a script path may carry: `$GITHUB_WORKSPACE/`,
 * `${GITHUB_WORKSPACE}/`, or the expression form `${{ github.workspace }}/`
 * (which survives YAML parsing verbatim inside a `run:` string).
 */
const WORKSPACE_PREFIX = String.raw`(?:\$\{?GITHUB_WORKSPACE\}?|\$\{\{\s*github\.workspace\s*\}\})\/`;
/**
 * The repo-script path itself. `knext/` is optional because the jobs that
 * check the repo out alongside next.js (`path: knext` — compat-vinext.yml,
 * test-e2e-deploy.yml) invoke `knext/scripts/…`, which is the dominant real
 * shape; the sibling scan in `compat-window-fingerprint-execution-scan.test.ts`
 * accepts the same prefix.
 */
const SCRIPT_PATH = String.raw`(?:knext\/)?scripts\/[\w./-]+\.(?:mjs|sh|js|ts|cjs|mts|py)`;
/**
 * Requires an execution verb (or `./`, or a direct workspace-prefixed
 * reference) immediately before the path — not a bare mention.
 *
 * #1422 — widened past `node|bash|sh|python3?`: `bun`/`bun run`/`tsx`/`bunx`
 * and `source`/`.` are real invokers for scripts; the path may carry the
 * optional `knext/` checkout-dir prefix and/or a workspace prefix; flags
 * between the verb and path are accepted (e.g. `node --test`, `bash -euo
 * pipefail`); and a step can reference a workspace-prefixed script with no
 * invoker in front. The `knext/` prefix is not hypothetical — before it was
 * accepted, 10 `node knext/scripts/…` invocations in compat-vinext.yml and
 * test-e2e-deploy.yml were invisible to this scan, and deleting
 * `shard-ledger`'s checkout stayed green.
 */
const SCRIPT_EXEC_RE = new RegExp(
  [
    String.raw`\b(?:node|bash|sh|python3?|bun(?:\s+run)?|bunx|tsx|source)\s+(?:[^\s"]+\s+)*"?(?:${WORKSPACE_PREFIX})?${SCRIPT_PATH}"?\b`,
    String.raw`(?:^|\s)"?\.\s+(?:[^\s"]+\s+)*"?(?:${WORKSPACE_PREFIX})?${SCRIPT_PATH}\b`,
    String.raw`(?:^|\s)"?\.\/${SCRIPT_PATH}\b`,
    String.raw`(?:^|\s)"?${WORKSPACE_PREFIX}${SCRIPT_PATH}"?\b`,
  ].join('|'),
  'm',
);
const CHECKOUT_USES_RE = /^actions\/checkout@/;
const DOWNLOAD_ARTIFACT_USES_RE = /^actions\/download-artifact@/;
const UPLOAD_ARTIFACT_USES_RE = /^actions\/upload-artifact@/;
const TARBALL_RE = /\.(?:tgz|tar(?:\.(?:gz|xz|zst|bz2))?)$/;
/**
 * The archive operand of every `tar x…f <archive>` in a command. Only the
 * basename is compared; a glob (`"$work"/*.tgz`) or an unresolved variable
 * never equals a real uploaded tarball name, so it fails closed.
 */
const TAR_EXTRACT_ARCHIVE_RE = /\btar\s+-?x[a-z]*f\s+("?)([^\s"]+)\1/g;

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

function withOf(step: YamlStep): Record<string, unknown> {
  const w = step.with;
  return w && typeof w === 'object' ? (w as Record<string, unknown>) : {};
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** artifact name -> the tarball basenames an `upload-artifact` step in this workflow uploads under it. */
type UploadedTarballs = ReadonlyMap<string, ReadonlySet<string>>;

function uploadedTarballsOf(jobs: Record<string, YamlJob>): UploadedTarballs {
  const out = new Map<string, Set<string>>();
  for (const job of Object.values(jobs)) {
    for (const step of stepsOf(job)) {
      if (typeof step.uses !== 'string' || !UPLOAD_ARTIFACT_USES_RE.test(step.uses)) continue;
      const { name, path } = withOf(step);
      if (typeof name !== 'string' || typeof path !== 'string') continue;
      for (const line of path.split('\n')) {
        const file = basename(line.trim());
        if (TARBALL_RE.test(file)) {
          if (!out.has(name)) out.set(name, new Set());
          out.get(name)?.add(file);
        }
      }
    }
  }
  return out;
}

/**
 * The tarball basenames a `download-artifact` step makes available — resolved
 * through the `name:` it downloads to what an `upload-artifact` step in the
 * same workflow uploaded under that name. A `pattern:` download or a name
 * nothing in this workflow uploads yields nothing. An unresolved `${{ }}`
 * expression in the download name DOES match an upload with the identical
 * expression (that is fine — both refer to the same artifact).
 */
function downloadedTarballs(step: YamlStep, uploads: UploadedTarballs): string[] {
  if (typeof step.uses !== 'string' || !DOWNLOAD_ARTIFACT_USES_RE.test(step.uses)) return [];
  const { name } = withOf(step);
  return typeof name === 'string' ? [...(uploads.get(name) ?? [])] : [];
}

/**
 * True if the step extracts a tarball an EARLIER `download-artifact` step in
 * the same job fetched (`downloaded`) — this repo's other way to provide the
 * repo (`deploy-tests` unpacks `compat-workspace.tgz`). #1422: tied to the
 * artifact that step downloaded, not merely to "some download happened": a
 * job that downloads shard summaries and then unpacks an unrelated tarball
 * (`next.tgz`, an adapter `*.tgz`) has not provided the repo.
 */
function isTarExtractStep(step: YamlStep, downloaded: ReadonlySet<string>): boolean {
  if (typeof step.run !== 'string') return false;
  for (const m of stripBashCommentLines(step.run).matchAll(TAR_EXTRACT_ARCHIVE_RE)) {
    if (downloaded.has(basename(m[2]))) return true;
  }
  return false;
}

function providesRepoContent(step: YamlStep, downloaded: ReadonlySet<string>): boolean {
  return isCheckoutStep(step) || isTarExtractStep(step, downloaded);
}

interface Finding {
  file: string;
  job: string;
  scriptStepLabel: string;
}

/**
 * For one job, every step that executes a repo script with no EARLIER
 * repo-providing step (checkout, or tar-extract of a downloaded tarball).
 */
function findingsForJob(
  file: string,
  jobName: string,
  job: YamlJob,
  uploads: UploadedTarballs,
): Finding[] {
  const findings: Finding[] = [];
  const downloaded = new Set<string>();
  let sawRepoContent = false;
  stepsOf(job).forEach((step, index) => {
    for (const t of downloadedTarballs(step, uploads)) downloaded.add(t);
    if (providesRepoContent(step, downloaded)) {
      sawRepoContent = true;
      return;
    }
    if (runsRepoScript(step) && !sawRepoContent) {
      const label = typeof step.name === 'string' ? step.name : `step #${index + 1}`;
      findings.push({ file, job: jobName, scriptStepLabel: label });
    }
  });
  return findings;
}

function findingsForWorkflow(file: string, jobs: Record<string, YamlJob>): Finding[] {
  const uploads = uploadedTarballsOf(jobs);
  return Object.entries(jobs).flatMap(([name, job]) => findingsForJob(file, name, job, uploads));
}

/** Every workflow, every job. */
function findMissingCheckoutBeforeScriptSteps(): Finding[] {
  return listWorkflowFiles().flatMap((file) => findingsForWorkflow(file, loadJobs(file)));
}

/** The set of tarballs downloaded by steps [0, index) of a job — for the per-job floor test. */
function downloadedBefore(
  steps: YamlStep[],
  index: number,
  uploads: UploadedTarballs,
): Set<string> {
  return new Set(steps.slice(0, index).flatMap((s) => downloadedTarballs(s, uploads)));
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

  it('non-vacuity: a tar-extract of the DOWNLOADED workspace tarball counts as repo-providing (the deploy-tests pattern, both workflows)', () => {
    for (const file of ['test-e2e-deploy.yml', 'compat-vinext.yml']) {
      const jobs = loadJobs(file);
      const uploads = uploadedTarballsOf(jobs);
      const steps = stepsOf(jobs['deploy-tests']);
      const tarIndex = steps.findIndex((s, i) =>
        isTarExtractStep(s, downloadedBefore(steps, i, uploads)),
      );
      expect(tarIndex, `${file}/deploy-tests: workspace unpack not recognised`).toBeGreaterThan(0);
    }
  });

  it('#1422: a tar-extract with NO preceding download of that tarball does not count — not even the literal workspace name', () => {
    expect(isTarExtractStep({ run: 'tar xzf compat-workspace.tgz' }, new Set())).toBe(false);
    expect(isTarExtractStep({ run: 'tar xzf "$work"/*.tgz -C "$work"' }, new Set())).toBe(false);
  });

  it('#1422: the tar exception is tied to the artifact NAME downloaded, not to "some download happened"', () => {
    const uploadJob: YamlJob = {
      steps: [
        {
          uses: 'actions/upload-artifact@x',
          with: { name: 'ws', path: '${{ runner.temp }}/workspace.tgz' },
        },
        {
          uses: 'actions/upload-artifact@x',
          with: { name: 'summaries', path: 'out/summary.json' },
        },
      ],
    };
    const consumer = (download: Record<string, unknown>, tar: string): YamlJob => ({
      steps: [
        { uses: 'actions/download-artifact@x', with: download },
        { name: 'unpack', run: tar },
        { name: 'run it', run: 'node knext/scripts/foo.mjs' },
      ],
    });
    const scan = (job: YamlJob) =>
      findingsForWorkflow('synthetic.yml', { build: uploadJob, consume: job }).map(
        (f) => f.scriptStepLabel,
      );
    // Downloads the workspace artifact and unpacks exactly its tarball: provided.
    expect(scan(consumer({ name: 'ws' }, 'tar xzf workspace.tgz'))).toEqual([]);
    // Downloads an UNRELATED artifact, then unpacks some tarball: not provided.
    expect(scan(consumer({ name: 'summaries' }, 'tar xzf workspace.tgz'))).toEqual(['run it']);
    // Downloads the workspace artifact but unpacks a DIFFERENT tarball: not provided.
    expect(scan(consumer({ name: 'ws' }, 'tar xzf next.tgz'))).toEqual(['run it']);
    // A pattern download cannot be resolved to a tarball name: fail closed.
    expect(scan(consumer({ pattern: 'ws*' }, 'tar xzf workspace.tgz'))).toEqual(['run it']);
  });

  it('#1422: SCRIPT_EXEC_RE recognises the knext/ checkout-dir prefix, bun run, and ${{ github.workspace }}', () => {
    expect(runsRepoScript({ run: 'node knext/scripts/compat-run-ledger.mjs' })).toBe(true);
    expect(runsRepoScript({ run: 'bun run scripts/foo.mjs' })).toBe(true);
    expect(runsRepoScript({ run: 'node ${{ github.workspace }}/scripts/foo.mjs' })).toBe(true);
    expect(runsRepoScript({ run: '"${{ github.workspace }}/knext/scripts/foo.sh"' })).toBe(true);
    expect(runsRepoScript({ run: './knext/scripts/foo.sh' })).toBe(true);
    // Still a bare mention, not an execution.
    expect(runsRepoScript({ run: 'echo "see knext/scripts/foo.mjs"' })).toBe(false);
  });

  it('non-vacuity: the real `node knext/scripts/…` invocations are all seen (compat-vinext.yml + test-e2e-deploy.yml)', () => {
    let seen = 0;
    for (const file of ['compat-vinext.yml', 'test-e2e-deploy.yml']) {
      for (const job of Object.values(loadJobs(file))) {
        for (const step of stepsOf(job)) {
          if (typeof step.run !== 'string') continue;
          const invocations = step.run.match(/\bnode knext\/scripts\//g)?.length ?? 0;
          if (invocations > 0) {
            expect(runsRepoScript(step), `${file}: ${String(step.name)}`).toBe(true);
            seen += invocations;
          }
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(10);
    // shard-ledger in compat-vinext.yml is one of them — the job whose
    // checkout could be deleted with this scan staying green before #1422.
    const shardLedger = stepsOf(loadJobs('compat-vinext.yml')['shard-ledger']);
    expect(shardLedger.some(runsRepoScript)).toBe(true);
  });

  it('#1422: SCRIPT_EXEC_RE recognises bun/tsx invokers and a $GITHUB_WORKSPACE/scripts/... reference', () => {
    expect(runsRepoScript({ run: 'bun scripts/foo.mjs' })).toBe(true);
    expect(runsRepoScript({ run: 'tsx scripts/foo.ts' })).toBe(true);
    expect(runsRepoScript({ run: 'node "$GITHUB_WORKSPACE/scripts/foo.mjs"' })).toBe(true);
    expect(runsRepoScript({ run: 'node "${GITHUB_WORKSPACE}/scripts/foo.mjs"' })).toBe(true);
    // A bare $GITHUB_WORKSPACE/scripts/... reference with NO invoker at all
    // (e.g. mounted into a container, or handed to a preload flag) is still
    // a real repo-file reference, not a prose mention.
    expect(runsRepoScript({ run: 'exec "$GITHUB_WORKSPACE/scripts/foo.sh"' })).toBe(true);
    // Still requires the .mjs/.sh/.js/.ts extension — a non-executable
    // reference (e.g. a --pin JSON path) is out of this detector's scope.
    expect(runsRepoScript({ run: '--pin "$GITHUB_WORKSPACE/scripts/foo.json"' })).toBe(false);
  });

  it('#1422: SCRIPT_EXEC_RE accepts flags between verb and path, new verbs (bunx, source), and new extensions (.cjs, .mts, .py)', () => {
    // Flags between verb and path
    expect(runsRepoScript({ run: 'node --test scripts/x.mjs' })).toBe(true);
    expect(runsRepoScript({ run: 'node --experimental-strip-types scripts/x.ts' })).toBe(true);
    expect(runsRepoScript({ run: 'bash -euo pipefail scripts/x.sh' })).toBe(true);
    // New verbs
    expect(runsRepoScript({ run: 'bunx scripts/foo.ts' })).toBe(true);
    expect(runsRepoScript({ run: 'source scripts/setup.sh' })).toBe(true);
    expect(runsRepoScript({ run: '. scripts/setup.sh' })).toBe(true);
    // New extensions
    expect(runsRepoScript({ run: 'node scripts/foo.cjs' })).toBe(true);
    expect(runsRepoScript({ run: 'bun run scripts/foo.mts' })).toBe(true);
    expect(runsRepoScript({ run: 'python3 scripts/foo.py' })).toBe(true);
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
      const uploads = uploadedTarballsOf(jobs);
      const repoIndex = steps.findIndex((step, idx) =>
        providesRepoContent(step, downloadedBefore(steps, idx, uploads)),
      );
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
