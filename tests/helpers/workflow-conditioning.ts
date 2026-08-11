/**
 * Structural audits for the two places a compat night is silenced from OUTSIDE
 * the fail-on-red script (#703).
 *
 * #700/#701 made the fail-on-red step's three teeth independently provable
 * INSIDE the shell script the step runs. Nothing in that work — nothing in
 * `tests/helpers/fail-on-red-gate.ts` either, by construction — can see the YAML
 * the step is wrapped in. Two edits that never touch the script silence the
 * whole night:
 *
 *   1. narrowing the `if: always()` of any step in the job's REPORTING TAIL, so
 *      the summary, the ledger artifact or the verdict simply never happens;
 *   2. a job-level `if:` on `deploy-tests` (or on anything the ledger needs), so
 *      the job is SKIPPED — and a skipped job does not fail a run, nor does it
 *      set `needs.<job>.result == 'failure'` for the alert job downstream.
 *
 * #697 already closed the equivalent holes on the fail-on-red step ITSELF
 * (`auditFailOnRedGate`) and `continue-on-error` everywhere
 * (`auditNoSwallowedFailures`). Measured on the tree this file landed on, those
 * two hold: `continue-on-error` reds in all three spellings at step AND job
 * level, and both narrowing and deleting the gate step's own `if:` red. What
 * stayed GREEN was every OTHER step in the tail, and every job-level `if:`.
 *
 * BOTH AUDITS ARE DERIVED FROM THE FILE, NOT FROM A LIST OF NAMES. That is the
 * lesson #701 paid for four times: an enumerated check misses the shape nobody
 * enumerated. The tail is located as a SUFFIX and the spine as a `needs:`
 * closure, so a step appended to the tail or a job inserted into the spine is
 * covered without anyone adding an assertion for it.
 *
 * AND EACH REPORTS A COUNT, because a derivation can fail in the direction it
 * came from as easily as the one it is going: deleting an `if:` from the middle
 * of the tail SHRINKS the suffix, and an audit that only judged what it found
 * would then pass by looking at less. The counts are what the caller asserts a
 * floor against.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { isAdmissibleIf } from '../../scripts/lib/workflow-conditioning-shapes.mjs';

/** The job whose reporting tail carries the compat verdict. */
export const VERDICT_JOB = 'deploy-tests';

/**
 * The job the reconciliation spine hangs from.
 *
 * `shard-ledger` rather than `deploy-tests`: the ledger is what reconciles the
 * run against the matrix (#695), so the closure rooted here is exactly the set
 * of jobs whose silence would go unnoticed.
 */
export const SPINE_ROOT = 'shard-ledger';

type YamlStep = { name?: unknown; if?: unknown } & Record<string, unknown>;
type YamlJob = { steps?: unknown; needs?: unknown; if?: unknown } & Record<string, unknown>;
type YamlDoc = { jobs?: Record<string, YamlJob> };

function loadJobs(workflowPath: string): Record<string, YamlJob> {
  const doc = parse(readFileSync(workflowPath, 'utf8')) as YamlDoc | null;
  return doc?.jobs ?? {};
}

function stepLabel(step: YamlStep, index: number): string {
  return typeof step.name === 'string' ? `\`${step.name}\`` : `#${index + 1}`;
}

export interface TailAudit {
  problems: string[];
  /** Steps in the trailing run of `if:`-carrying steps. */
  tailLength: number;
  /** Steps in the job, so a floor can be stated relative to the whole. */
  totalSteps: number;
  /** The tail's step labels, in document order — for the failure message. */
  tailLabels: string[];
}

/**
 * The REPORTING TAIL of `deploy-tests`: every step that must run even after an
 * earlier step in the job has failed.
 *
 * DERIVED AS A SUFFIX. The tail is the longest run of steps at the END of the
 * job in which every step DECLARES an `if:` — a structural property of the
 * file, not a list of three names that would go stale the first time a fourth
 * step is appended. Every step in it must then carry an ADMISSIBLE `if:`.
 *
 * Two directions, both deliberate:
 *
 *   - a step in the tail whose `if:` is narrowed is reported here;
 *   - a step whose `if:` is DELETED leaves the suffix, shrinking `tailLength`,
 *     and is therefore invisible to `problems`. That is not an oversight — it
 *     is why the count is returned. The caller asserts a floor, and the floor is
 *     what reds.
 *
 * Fails closed on the case it cannot classify: a step inserted immediately
 * before the tail WITH a conditional `if:` joins the suffix and is reported.
 * That is a louder outcome than silently shortening the tail, and the message
 * says what to do about it.
 */
export function auditReportingTail(workflowPath: string, jobId = VERDICT_JOB): TailAudit {
  const jobs = loadJobs(workflowPath);
  const job = jobs[jobId];
  if (!job) {
    return {
      problems: [`job \`${jobId}\` is not defined in this workflow`],
      tailLength: 0,
      totalSteps: 0,
      tailLabels: [],
    };
  }
  const steps = Array.isArray(job.steps) ? (job.steps as YamlStep[]) : null;
  if (!steps) {
    return {
      problems: [`job \`${jobId}\` has no \`steps:\` list — it cannot be running anything`],
      tailLength: 0,
      totalSteps: 0,
      tailLabels: [],
    };
  }

  let first = steps.length;
  while (first > 0) {
    const candidate = steps[first - 1];
    if (candidate === null || typeof candidate !== 'object' || !('if' in candidate)) break;
    first -= 1;
  }

  const problems: string[] = [];
  const tailLabels: string[] = [];
  for (let i = first; i < steps.length; i++) {
    const step = steps[i];
    tailLabels.push(stepLabel(step, i));
    if (isAdmissibleIf(step.if)) continue;
    problems.push(
      `job \`${jobId}\` step ${stepLabel(step, i)} is in the reporting tail but carries ` +
        `if: ${JSON.stringify(step.if)} — only \`always()\` (or \`\${{ always() }}\`) is admissible ` +
        'there. Every step from here to the end of the job runs AFTER a shard step that may have ' +
        'failed, timed out or been evicted; condition any of them and the summary, the ledger ' +
        'artifact or the red verdict silently does not happen, and the night concludes SUCCESS. ' +
        'If this step is genuinely conditional it does not belong at the end of this job — move ' +
        'it above the tail.',
    );
  }

  return { problems, tailLength: steps.length - first, totalSteps: steps.length, tailLabels };
}

export interface SpineAudit {
  problems: string[];
  /** Job ids walked, root first, in discovery order. */
  jobsWalked: string[];
}

/**
 * The RECONCILIATION SPINE: `shard-ledger` and every job it transitively
 * `needs:`.
 *
 * None of them may be conditioned off. A job-level `if:` that is not `always()`
 * makes the job SKIP, and a skipped job fails nothing — `needs.<job>.result` is
 * then `'skipped'`, which the nightly alert's own condition tests for
 * `'failure'` and `'cancelled'` and therefore misses. One line at the top of
 * `deploy-tests` disarms all three fail-on-red teeth, the ledger, and the alert
 * together, without touching any of them.
 *
 * Absent is fine — a job with no `if:` runs. `always()` is fine and is what
 * `shard-ledger` legitimately carries. Everything else is reported, including
 * expressions that would in fact evaluate true: see the note on judging form
 * rather than value in `scripts/lib/workflow-conditioning-shapes.mjs`.
 *
 * The closure is returned so the caller can assert a floor on its size. Deleting
 * `needs: build-next` shrinks the spine rather than adding a problem, which is
 * the same shrink-the-denominator direction the tail audit's count covers.
 */
export function auditLedgerSpine(workflowPath: string, rootId = SPINE_ROOT): SpineAudit {
  const jobs = loadJobs(workflowPath);
  const problems: string[] = [];
  const walked: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ id: string; via: string[] }> = [{ id: rootId, via: [] }];

  while (queue.length > 0) {
    const { id, via } = queue.shift() as { id: string; via: string[] };
    if (seen.has(id)) continue;
    seen.add(id);
    walked.push(id);

    const job = jobs[id];
    const label =
      via.length === 0 ? `job \`${id}\`` : `job \`${id}\` (needed by ${via.join(' -> ')})`;
    if (!job || typeof job !== 'object') {
      problems.push(`${label} is not defined in this workflow`);
      continue;
    }

    if ('if' in job && !isAdmissibleIf(job.if)) {
      problems.push(
        `${label} carries a job-level if: ${JSON.stringify(job.if)} — only an ABSENT \`if:\` or ` +
          '`always()` is admissible on the reconciliation spine. A skipped job fails nothing, ' +
          "sets `needs.<job>.result` to 'skipped' rather than 'failure', and so files no alert " +
          'either: one line here silences the whole night.',
      );
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

  return { problems, jobsWalked: walked };
}
