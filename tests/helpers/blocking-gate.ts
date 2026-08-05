import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * "Is this workflow job actually a blocking gate?" — asked of the PARSED
 * workflow, not of its text (#661).
 *
 * WHY PARSED. The guards in `tests/bun-exec-*-ci.test.ts` used to ask this with
 * two regexes over the job's lines: `^ {4}if:` and `continue-on-error:\s*true`.
 * Three single-edit, valid-YAML disarms were then MEASURED to pass both while
 * every other assertion in those files stayed green:
 *
 *   - `"if": false`  — a quoted mapping key is exactly equivalent to `if:` and
 *     the four-space anchor does not match it;
 *   - `continue-on-error: ${{ true }}` — an expression, not the literal `true`;
 *   - `needs: <a job that can skip>` — a job needing a skipped job is itself
 *     skipped, and a skipped job does not fail the run. The gate disappears
 *     without its own definition being touched.
 *
 * Answering that with three more patterns is the same defect one level up — the
 * repo has now hit the enumerate-the-forms trap three times (variables →
 * interpolation syntaxes → positional forms), and `workflow.md` says it plainly:
 * PREFER SCANNING TO ENUMERATING, make the unparseable construct FAIL rather
 * than pass.
 *
 * So the audit does two things a regex cannot:
 *
 *   1. It reads KEYS, not lines. `if`, `"if"`, `'if'` and a flow-mapping job all
 *      parse to the same key, so quoting is not a hiding place.
 *   2. It FAILS CLOSED on any job-level key it does not recognise. A future
 *      GitHub key that can neutralise a job does not need to be predicted here;
 *      it lands as an unrecognised key and reddens, and whoever adds it
 *      deliberately widens the allowlist with a reason. That is the whole point:
 *      the list below is not "the ways to disable a job" (unknowable) but "the
 *      keys we have decided cannot".
 *
 * `yaml` is a root dependency (#653), so the older "read as text, the root
 * package has no yaml dependency" convention no longer has its reason.
 *
 * WHO CALLS THIS, AND WHO DELIBERATELY DOES NOT (#672)
 * ---------------------------------------------------
 * #667 wired two callers and left the siblings behind, which is the whole reason
 * #672 existed. So the triage is recorded here, next to the engine, rather than
 * in a PR body nobody re-reads.
 *
 * Converted — every guard claiming a `ci.yml` job is a blocking PR gate:
 * `bun-exec-hardcap`, `bun-exec-alpine-image`, `compile-cache-bun-probe`,
 * `typecheck-root`, and `lint-and-test` (the mutation-residue scan's step).
 * `scripts/mutation-prove-ci-blocking-gates.mjs` disarms all five, five ways.
 *
 * NOT converted, and each for a reason that is not "we ran out of diff":
 *
 *   - NO `pull_request` TRIGGER — `tests/compat-shard-flake-attribution.test.ts`
 *     (test-e2e-deploy.yml: workflow_dispatch + schedule),
 *     `tests/operator-e2e-scale-image-preflight.test.ts` (operator-e2e-nightly.yml),
 *     `tests/docs-closure-nightly-workflow.test.ts` (docs-closure-nightly.yml).
 *     This audit asserts a `pull_request` trigger, so pointing them here would
 *     red for a reason that is not a defect, and the fix would be to weaken the
 *     trigger half. A nightly is not a PR gate and must not be described as one.
 *     (The operator preflight already parses rather than text-matches; its
 *     bespoke checks are a subset of these, minus the trigger half.)
 *   - PR-TRIGGERED BUT DELIBERATELY `paths:`-SCOPED —
 *     `tests/operator-image-pin-resolution.test.ts`
 *     (image-pin-resolution-nightly.yml). This category exists because the
 *     round-2 review MEASURED the reason first recorded for this entry to be
 *     false: it was filed above as "scheduled, not `pull_request`", but the
 *     workflow does carry `pull_request:` — under a `paths:` filter
 *     (`.github/workflows/image-pin-resolution-nightly.yml:55-56`), and
 *     `auditBlockingGate` against its `resolve-image-pins` job reports exactly
 *     one problem, "the `pull_request` trigger carries a `paths` filter", NOT a
 *     missing trigger. The exemption survives — a paths-scoped run is not the
 *     unconditional gate this audit certifies — but the reason did not, and a
 *     wrong reason in a self-reported exemption list is the silent-exemption
 *     shape `workflow.md` says to watch for. Its guard still carries the
 *     evadable text form (`operator-image-pin-resolution.test.ts:324`,
 *     `not.toMatch(/continue-on-error:\s*true/)`) on a workflow that DOES run on
 *     PRs — a live #661-class instance, tracked as #677 rather than smuggled
 *     into this diff.
 *   - THE OPPOSITE CLAIM — `tests/supply-chain-workflow.test.ts`,
 *     `tests/operator-supply-chain-workflow.test.ts`, and the `docs-site` half of
 *     `tests/docs-closure-nightly-workflow.test.ts` — these assert a
 *     `continue-on-error` is PRESENT and constrained to the PR phase
 *     (report-on-PR / fail-on-main). That is the OPPOSITE claim to the one this
 *     audit makes, not a weaker form of it.
 *
 * HOW MUCH OF THIS IS ENFORCED. The two trigger categories are claims about a
 * workflow's `on:` block, so they are now DERIVED FROM THE PARSE and compared —
 * `UNCONVERTED_GUARD_TRIAGE` below is the list as data and
 * `tests/blocking-gate-triage.test.ts` reds if any recorded reason stops being
 * the real one, or if an exempt workflow gains an unconditional `pull_request`
 * trigger. Fixing only the entry the review named would have been this repo's
 * own enumerate-rather-than-scan defect one level up.
 *
 * The `opposite-claim` third stays documented practice. A scan was written to
 * enforce it and was DROPPED: it flagged the phased-rollout guards, because
 * file-level text cannot tell which workflow a `continue-on-error` pattern is
 * applied to — `docs-closure-nightly-workflow.test.ts:257-263` asserts such a
 * step is PRESENT and PR-gated while `:142-149` asserts its ABSENCE on the
 * nightly, in one file. The only ways to keep the scan were an allowlist or a
 * heuristic that would be edited rather than obeyed, both the silent-exemption
 * shape this repo has already had to unwind. By `security.md`'s own standard
 * that third can decay — stated rather than dressed up.
 */

/**
 * Job-level keys that provably cannot stop the job from running or stop its
 * failure from failing the run.
 *
 * `needs` is present but is NOT waved through — it is audited transitively
 * below, because it is the indirection the text guards missed entirely.
 *
 * Deliberately ABSENT, and each absence is load-bearing: `if` (skips),
 * `continue-on-error` (unfails), `strategy` (a matrix that expands to zero jobs
 * runs nothing), `concurrency` (`cancel-in-progress` can cancel it),
 * `environment` (a protection rule can hold or reject it), `uses`/`with`/`secrets`
 * (a reusable workflow moves the whole definition somewhere this audit is not
 * looking), and `defaults`.
 *
 * `defaults` was allowlisted in the first round and that was a misclassification
 * in the PERMISSIVE direction, which is the direction that matters here: the
 * allowlist's correctness IS the design. `defaults: run: shell: bash {0}`
 * replaces GitHub's default `bash -eo pipefail {0}`, and `-e`/`pipefail` are
 * exactly what make an intermediate command in a multi-line `run:` fail the
 * step. So it can stop a failure from failing the run, which is the one thing
 * this list certifies cannot happen.
 */
const ALLOWED_JOB_KEYS = new Set([
  'name',
  'runs-on',
  'steps',
  'needs',
  'env',
  'permissions',
  'timeout-minutes',
  'outputs',
  'services',
  'container',
]);

/**
 * Why a guard that asserts something about a workflow is NOT pointed at
 * `auditBlockingGate`.
 *
 * `no-pull-request-trigger` and `paths-scoped-pull-request` are claims about the
 * workflow's `on:` block, so they are MEASURED — see
 * `tests/blocking-gate-triage.test.ts`. `opposite-claim` is a claim about what
 * the guard asserts, which file-level text cannot establish, so it stays
 * documented practice.
 */
export type TriageCategory =
  | 'no-pull-request-trigger'
  | 'paths-scoped-pull-request'
  | 'opposite-claim';

export interface TriageEntry {
  /** Repo-relative path of the guard that is not converted. */
  test: string;
  /** Repo-relative path of the workflow it guards. */
  workflow: string;
  category: TriageCategory;
  why: string;
}

/**
 * The triage in the header above, as DATA so it can be checked rather than
 * merely read.
 *
 * The round-2 review found the reason recorded for one entry was measurably
 * false: `image-pin-resolution-nightly.yml` was filed under "SCHEDULED, not
 * `pull_request`", but it carries a `pull_request:` trigger with a `paths:`
 * filter. The exemption survives — a deliberately paths-scoped gate is not an
 * unconditional PR gate — but the reason was wrong, and a wrong reason in a
 * self-reported exemption list is exactly the silent-exemption shape
 * `workflow.md` says to watch for.
 *
 * Fixing only the named entry would be the enumerate-not-scan defect one level
 * up, so the trigger half of every entry is now asserted against the parse.
 */
export const UNCONVERTED_GUARD_TRIAGE: readonly TriageEntry[] = [
  {
    test: 'tests/compat-shard-flake-attribution.test.ts',
    workflow: '.github/workflows/test-e2e-deploy.yml',
    category: 'no-pull-request-trigger',
    why: 'workflow_dispatch + schedule only; a nightly is not a PR gate',
  },
  {
    test: 'tests/operator-image-pin-resolution.test.ts',
    workflow: '.github/workflows/image-pin-resolution-nightly.yml',
    category: 'paths-scoped-pull-request',
    why: 'runs on pull_request, but only under a paths: filter — deliberately scoped, so it is not an unconditional PR gate',
  },
  {
    test: 'tests/operator-e2e-scale-image-preflight.test.ts',
    workflow: '.github/workflows/operator-e2e-nightly.yml',
    category: 'no-pull-request-trigger',
    why: 'schedule + workflow_dispatch only',
  },
  {
    test: 'tests/docs-closure-nightly-workflow.test.ts',
    workflow: '.github/workflows/docs-closure-nightly.yml',
    category: 'no-pull-request-trigger',
    why: 'schedule + workflow_dispatch only',
  },
  {
    test: 'tests/supply-chain-workflow.test.ts',
    workflow: '.github/workflows/supply-chain.yml',
    category: 'opposite-claim',
    why: 'asserts a continue-on-error is PRESENT and constrained to the PR phase',
  },
  {
    test: 'tests/operator-supply-chain-workflow.test.ts',
    workflow: '.github/workflows/operator-supply-chain.yml',
    category: 'opposite-claim',
    why: 'asserts a continue-on-error is PRESENT and constrained to the PR phase',
  },
];

/** What a workflow's `pull_request:` trigger actually is, from the parse. */
export type TriggerShape =
  | 'no-pull-request-trigger'
  | 'paths-scoped-pull-request'
  | 'unconditional-pull-request'
  | 'otherwise-filtered-pull-request';

/**
 * Classify a workflow's `pull_request:` trigger.
 *
 * Deliberately narrower than `auditBlockingGate`'s trigger half, which asks "can
 * this gate be skipped" and so fails closed on every filter key. This asks the
 * triage's question — "is the recorded reason for exempting this guard the real
 * one" — and therefore has to tell a `paths:` filter apart from a `branches:`
 * one rather than collapsing both to "has a problem".
 */
export function classifyTriggerShape(workflowPath: string): TriggerShape {
  const doc = parse(readFileSync(workflowPath, 'utf8')) as Record<string, unknown> | null;
  const on = (doc?.on ?? doc?.[true as unknown as string]) as Record<string, unknown> | undefined;
  if (!on || typeof on !== 'object' || !('pull_request' in on)) return 'no-pull-request-trigger';

  const pr = on.pull_request;
  if (pr === null || typeof pr !== 'object') return 'unconditional-pull-request';

  const keys = Object.keys(pr as Record<string, unknown>).filter(
    (key) => !(key === 'branches' && isUniversalBranchFilter((pr as Record<string, unknown>)[key])),
  );
  if (keys.length === 0) return 'unconditional-pull-request';
  if (keys.every((key) => key === 'paths' || key === 'paths-ignore')) {
    return 'paths-scoped-pull-request';
  }
  return 'otherwise-filtered-pull-request';
}

export interface BlockingGateOptions {
  /** Absolute path to the workflow file. */
  workflowPath: string;
  /** The job whose blocking-ness is being asserted. */
  jobId: string;
  /**
   * Matches the `run:` of the step that IS the gate. That step gets the extra
   * scrutiny a regex over the whole job block cannot give: a step-level `if:` is
   * legitimate in general, but not on the one step the gate exists to run.
   */
  gateCommand: RegExp;
}

export interface BlockingGateAudit {
  /** Everything wrong. Empty means the job is a blocking gate. */
  problems: string[];
  /** Non-vacuity: how many jobs the parse actually saw. */
  jobsSeen: number;
  /** Non-vacuity: how many steps matched `gateCommand`. */
  gateStepsSeen: number;
  /** The transitive `needs` closure that was audited, for reporting. */
  needsClosure: string[];
}

type Job = Record<string, unknown>;

/**
 * Is this `branches:` value provably equivalent to having no filter at all?
 *
 * Only `**` is. `*` is NOT, and the difference is the live defect this audit was
 * extended to catch: GitHub filter patterns give `*` "zero or more characters,
 * but NOT `/`", so `branches: ['*']` matches `main` and misses every slashed
 * branch. Measured, not read: PR #583 (base `chore/gitignore-agent-artifacts`)
 * ran ZERO jobs from a workflow carrying `branches: ['*']`, while
 * `install-smoke.yml` — which uses `['**']` — ran normally on the same PR.
 * Stacked PRs onto slashed branches are this repo's normal mode.
 */
function isUniversalBranchFilter(value: unknown): boolean {
  const list = Array.isArray(value) ? value : [value];
  return list.some((entry) => entry === '**');
}

/** `continue-on-error` is a problem in every form except a literal `false`. */
function continueOnErrorProblem(container: Job, where: string): string | null {
  if (!('continue-on-error' in container)) return null;
  const value = container['continue-on-error'];
  if (value === false) return null;
  return `${where} carries continue-on-error: ${JSON.stringify(value)} — its failure cannot fail the run`;
}

/**
 * The checks that apply to the gate job AND to everything it `needs`.
 *
 * Returns the transitive `needs` closure it walked. That is the SAME walk the
 * caller used to repeat in a second `collect` recursion; two implementations of
 * one rule can only diverge, so there is now one.
 */
function auditJobCanNotSkip(
  jobs: Record<string, Job>,
  jobId: string,
  problems: string[],
): string[] {
  const seen = new Set<string>();
  const queue: Array<{ id: string; via: string[] }> = [{ id: jobId, via: [] }];

  while (queue.length > 0) {
    const { id, via } = queue.shift() as { id: string; via: string[] };
    if (seen.has(id)) continue;
    seen.add(id);

    const job = jobs[id];
    const label =
      via.length === 0 ? `job \`${id}\`` : `job \`${id}\` (needed by ${via.join(' -> ')})`;

    if (job === undefined || job === null || typeof job !== 'object') {
      problems.push(`${label} is not defined in this workflow`);
      continue;
    }

    if ('if' in job) {
      problems.push(
        `${label} carries a job-level \`if:\` (${JSON.stringify(job.if)}) — it can be conditioned off a pull request, and a skipped job does not fail the run`,
      );
    }

    const coe = continueOnErrorProblem(job, label);
    if (coe) problems.push(coe);

    for (const key of Object.keys(job)) {
      if (!ALLOWED_JOB_KEYS.has(key) && key !== 'if' && key !== 'continue-on-error') {
        problems.push(
          `${label} carries the unrecognised job-level key \`${key}\` — this audit fails closed: either it cannot neutralise the gate (add it to ALLOWED_JOB_KEYS with a reason) or it can`,
        );
      }
    }

    // Steps: `continue-on-error` anywhere in the job is a disarm, whichever step
    // carries it — scanned, not enumerated, so a step added later is covered.
    const steps = job.steps;
    if (Array.isArray(steps)) {
      steps.forEach((step, i) => {
        if (step === null || typeof step !== 'object') return;
        const name = (step as Job).name;
        const stepLabel = `${label} step ${typeof name === 'string' ? `\`${name}\`` : `#${i + 1}`}`;
        const stepCoe = continueOnErrorProblem(step as Job, stepLabel);
        if (stepCoe) problems.push(stepCoe);
      });
    } else {
      // No `uses:` exemption here: a reusable-workflow job is ALREADY reported by
      // the allowlist above (`uses` is deliberately not in ALLOWED_JOB_KEYS), so
      // the guard this branch used to carry could never change an outcome.
      problems.push(`${label} has no \`steps:\` list — it cannot be running anything`);
    }

    const needs = job.needs;
    const deps = typeof needs === 'string' ? [needs] : Array.isArray(needs) ? needs : [];
    for (const dep of deps) {
      if (typeof dep !== 'string') {
        problems.push(`${label} has a non-string entry in \`needs:\``);
        continue;
      }
      queue.push({ id: dep, via: [...via, id] });
    }
  }

  return [...seen];
}

/**
 * Audit `jobId` in `workflowPath` as a blocking, always-runs-on-PR gate.
 *
 * Returns problems rather than throwing so the caller can assert on the whole
 * list at once (and so a failure names every defect, not just the first).
 */
export function auditBlockingGate(options: BlockingGateOptions): BlockingGateAudit {
  const { workflowPath, jobId, gateCommand } = options;
  const problems: string[] = [];

  const raw = readFileSync(workflowPath, 'utf8');
  const doc = parse(raw) as Record<string, unknown> | null;

  const jobs = (doc?.jobs ?? null) as Record<string, Job> | null;
  if (jobs === null || typeof jobs !== 'object') {
    // Non-vacuity, hard: an unparseable or restructured workflow must fail, not
    // pass by having no jobs to find fault with.
    return {
      problems: [`${workflowPath} has no \`jobs:\` mapping`],
      jobsSeen: 0,
      gateStepsSeen: 0,
      needsClosure: [],
    };
  }

  // The trigger half. A job that is perfect in every other way still does not
  // gate a PR if the workflow does not run on one, or if a path filter can skip
  // the whole run.
  const on = (doc?.on ?? doc?.[true as unknown as string]) as Record<string, unknown> | undefined;
  const pr =
    on && typeof on === 'object' ? (on as Record<string, unknown>).pull_request : undefined;
  if (on === undefined || !(on && typeof on === 'object' && 'pull_request' in on)) {
    problems.push(`${workflowPath} does not trigger on \`pull_request\` — nothing here gates a PR`);
  } else if (pr !== null && typeof pr === 'object') {
    // Fail closed on EVERY key under the trigger, the same inversion used for
    // job-level keys. The first round checked only `paths`/`paths-ignore`, and
    // the three siblings it left out are all live disarms — measured GREEN on
    // both real gate jobs: `branches: ['no-such-branch']`, `branches-ignore:
    // ['**']`, `types: [labeled]`.
    //
    // The sole exemption is a `branches` list that is UNIVERSAL, because that is
    // provably equivalent to omitting the filter. Anything else, including a
    // future trigger key nobody predicted here, lands as a problem and whoever
    // adds it widens this deliberately.
    for (const key of Object.keys(pr as Record<string, unknown>)) {
      if (key === 'branches' && isUniversalBranchFilter((pr as Record<string, unknown>)[key])) {
        continue;
      }
      problems.push(
        `the \`pull_request\` trigger carries a \`${key}\` filter, so a PR can be merged without this gate ever running`,
      );
    }
  }

  const needsClosure = auditJobCanNotSkip(jobs, jobId, problems);

  // The gate step itself. A step-level `if:` is legitimate in general — but not
  // on the step the whole job exists to run.
  const job = jobs[jobId];
  const steps = Array.isArray(job?.steps) ? (job.steps as Job[]) : [];
  const gateSteps = steps.filter((s) => {
    const run = s && typeof s === 'object' ? s.run : undefined;
    return typeof run === 'string' && gateCommand.test(run);
  });
  for (const step of gateSteps) {
    if ('if' in step) {
      const name = typeof step.name === 'string' ? step.name : '(unnamed)';
      problems.push(
        `the gate step \`${name}\` carries an \`if:\` (${JSON.stringify(step.if)}) — the job can run green without ever running the gate`,
      );
    }
  }

  return {
    problems,
    jobsSeen: Object.keys(jobs).length,
    gateStepsSeen: gateSteps.length,
    needsClosure,
  };
}
