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
 * looking).
 */
const ALLOWED_JOB_KEYS = new Set([
  'name',
  'runs-on',
  'steps',
  'needs',
  'env',
  'defaults',
  'permissions',
  'timeout-minutes',
  'outputs',
  'services',
  'container',
]);

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

/** `continue-on-error` is a problem in every form except a literal `false`. */
function continueOnErrorProblem(container: Job, where: string): string | null {
  if (!('continue-on-error' in container)) return null;
  const value = container['continue-on-error'];
  if (value === false) return null;
  return `${where} carries continue-on-error: ${JSON.stringify(value)} — its failure cannot fail the run`;
}

/** The checks that apply to the gate job AND to everything it `needs`. */
function auditJobCanNotSkip(jobs: Record<string, Job>, jobId: string, problems: string[]): void {
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
    } else if (!('uses' in job)) {
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
    for (const filter of ['paths', 'paths-ignore']) {
      if (filter in (pr as Record<string, unknown>)) {
        problems.push(
          `the \`pull_request\` trigger carries a \`${filter}\` filter, so a PR can be merged without this gate ever running`,
        );
      }
    }
  }

  auditJobCanNotSkip(jobs, jobId, problems);

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

  const closure: string[] = [];
  const collect = (id: string) => {
    if (closure.includes(id)) return;
    closure.push(id);
    const j = jobs[id];
    const n = j?.needs;
    const deps = typeof n === 'string' ? [n] : Array.isArray(n) ? n : [];
    for (const d of deps) if (typeof d === 'string') collect(d);
  };
  collect(jobId);

  return {
    problems,
    jobsSeen: Object.keys(jobs).length,
    gateStepsSeen: gateSteps.length,
    needsClosure: closure,
  };
}
