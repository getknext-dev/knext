import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_OUT_FILE } from '../scripts/compat-run-ledger.mjs';
// Both scripts are untyped `.mjs`, but the root typecheck gate runs with
// `allowJs`, so tsc infers their real shapes from JSDoc. That is why these
// imports need no `@ts-expect-error` — and why `failures[]`/`notRunFiles[]`
// have to be declared on ShardSummary in e2e-summary.mjs rather than asserted
// away here. The gate exists to keep `tests/` honest (#527).
import { classifyRuns, renderLedgerTable } from '../scripts/e2e-shard-history.mjs';
import { summarize } from '../scripts/e2e-summary.mjs';
import { continueOnErrorProblem, type Job } from './helpers/blocking-gate';

const WORKFLOW = readFileSync(join(process.cwd(), '.github/workflows/test-e2e-deploy.yml'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// T1 / #545 — the flake ATTRIBUTION contract.
//
// MECHANISM (measured, not assumed — see the PR body):
//   * The failing-shard set is STABLE, not rotating, and it is LANE-PARTITIONED.
//     Every "shards 6 and 8" red (2026-07-05, -07-19, -07-26) fell on a Sunday,
//     i.e. the WEEKLY BUN lane (cron '17 5 * * 0'); the node credential lane had
//     exactly ONE shard-level red in the 22 scheduled runs since 2026-07-05.
//   * That one node red (run 29984259723, shard 2/16) was
//     test/e2e/app-dir/segment-cache/dynamic-on-hover — a member of the
//     ALREADY-ROOT-CAUSED #214 segment-cache runtime-prefetch family
//     (vercel/next.js#95301). Nine siblings are quarantined with that ref;
//     dynamic-on-hover is not, because the family was captured as an ENUMERATED
//     file list. Signature: a bare `Exceeded timeout of 60000 ms for a test.`
//     on all three retries, with no assertion — a HANG, not slowness.
//
// WHY THIS FILE EXISTS: none of that was queryable. The per-shard summary
// artifact carried COUNTS only, so "which test failed" required downloading job
// logs, which is exactly what makes a re-run erase the signal (#545 AC 3). The
// contract asserted below is that a red shard NAMES its failing files and
// CLASSIFIES the failure, and that per-shard outcomes survive long enough to be
// counted across the 14-night window.
// ─────────────────────────────────────────────────────────────────────────────

// A faithful, de-timestamped slice of run 29984259723 shard 2/16 (the node-lane
// red): run-tests.js group boundaries + the jest verbose block inside them.
const DYNAMIC_ON_HOVER_RED = `
total: 49
Starting test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts retry 0/2
❌ test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts output:
FAIL Turbopack test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts (148.075 s)
  dynamic on hover
    ✕ prefetches the dynamic data for a Link on hover (60001 ms)

  ● dynamic on hover › prefetches the dynamic data for a Link on hover

    thrown: "Exceeded timeout of 60000 ms for a test.
    Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
end of test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts output
test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts failed due to Error: failed with code: 1
test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts failed to pass within 2 retries
`;

// A faithful slice of the BUN lane red (run 30193384289 shard 6/16): the same
// file carries BOTH a bare-timeout case and fast assertion failures.
const BUN_ASSERTION_RED = `
total: 49
❌ test/e2e/app-dir/app-static/app-static.test.ts output:
FAIL Turbopack test/e2e/app-dir/app-static/app-static.test.ts (204.9 s)
    ✕ should handle partial-gen-params with layout dynamicParams = false correctly (11 ms)
    ✕ should handle dynamicParams: false correctly (59 ms)

  ● app-static › should handle dynamicParams: false correctly

    expect(received).toBe(expected)
end of test/e2e/app-dir/app-static/app-static.test.ts output
test/e2e/app-dir/app-static/app-static.test.ts failed to pass within 2 retries
`;

const GREEN_SHARD = `
total: 2
test/e2e/app-dir/a/a.test.ts finished on retry 0/2 in 12.0s
test/e2e/app-dir/b/b.test.ts finished on retry 0/2 in 9.0s
`;

const meta = { ref: 'v16.2.0', shard: '2/16', excluded: 44, runtime: 'node' };

type ShardSummary = ReturnType<typeof summarize>;
type ShardFailure = NonNullable<ShardSummary['failures']>[number];

/**
 * `failures` is OPTIONAL by contract — it is omitted on a green shard so the
 * node artifact stays byte-stable for the #41 publisher. These narrow it by
 * throwing rather than by casting: if attribution ever stops being emitted the
 * test fails loudly with a real message, which is what makes the mutation proof
 * meaningful. A cast would have swallowed exactly that.
 */
function failuresOf(s: ShardSummary): ShardFailure[] {
  const failures = s.failures;
  if (!failures) throw new Error('expected the shard summary to carry named failures');
  return failures;
}

function firstFailure(s: ShardSummary): ShardFailure {
  const [first] = failuresOf(s);
  if (!first) throw new Error('expected at least one named failure');
  return first;
}

describe('#545 — a red shard NAMES its failing tests (summary artifact is the ledger)', () => {
  it('lists the failing test FILE, not just a count', () => {
    const s = summarize(DYNAMIC_ON_HOVER_RED, meta);
    expect(s.failed).toBe(1);
    expect(s.failures).toEqual([
      expect.objectContaining({
        file: 'test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts',
      }),
    ]);
  });

  it('classifies the bare per-case jest timeout as kind "timeout" (the #95301 hang signature)', () => {
    const failure = firstFailure(summarize(DYNAMIC_ON_HOVER_RED, meta));
    expect(failure.kind).toBe('timeout');
    expect(failure.timeoutMs).toBe(60000);
  });

  it('names the failing CASE, de-duplicated across retries', () => {
    // The real log prints the ✕ line once per retry (3 retries). One entry.
    const thrice = DYNAMIC_ON_HOVER_RED.repeat(3);
    expect(firstFailure(summarize(thrice, meta)).cases).toEqual([
      'prefetches the dynamic data for a Link on hover',
    ]);
  });

  it('classifies a non-timeout failure as kind "assertion" (so the two are never conflated)', () => {
    const failure = firstFailure(summarize(BUN_ASSERTION_RED, { ...meta, runtime: 'bun' }));
    expect(failure.kind).toBe('assertion');
    expect(failure.timeoutMs).toBeUndefined();
    expect(failure.cases).toContain('should handle dynamicParams: false correctly');
  });

  it('OMITS the failures key on a green shard (node artifact stays byte-stable for the #41 publisher)', () => {
    const s = summarize(GREEN_SHARD, meta);
    expect(s.failed).toBe(0);
    expect(Object.keys(s)).not.toContain('failures');
    expect(Object.keys(s)).not.toContain('notRunFiles');
  });

  it('names phantom infra-abort files under notRunFiles, never under failures', () => {
    const phantom = `
total: 1
❌ test/e2e/app-dir/ghost/ghost.test.ts output:
No tests found, exiting with code 1
end of test/e2e/app-dir/ghost/ghost.test.ts output
test/e2e/app-dir/ghost/ghost.test.ts failed to pass within 2 retries
`;
    const s = summarize(phantom, meta);
    expect(s.notRun).toBe(1);
    expect(s.notRunFiles).toEqual(['test/e2e/app-dir/ghost/ghost.test.ts']);
    expect(Object.keys(s)).not.toContain('failures');
  });

  it('keeps the failure record LANE-attributable (bun and node reds are never pooled)', () => {
    const s = summarize(DYNAMIC_ON_HOVER_RED, { ...meta, runtime: 'bun' });
    expect(s.runtime).toBe('bun');
    expect(s.failures).toHaveLength(1);
  });
});

describe('#545 AC1 — per-shard outcomes are queryable across scheduled runs, lane labelled', () => {
  const runs = [
    {
      databaseId: 30193384289,
      createdAt: '2026-07-26T07:46:00Z',
      event: 'schedule',
      conclusion: 'failure',
      jobs: [
        { name: 'Deploy tests (shard 6/16)', conclusion: 'failure' },
        { name: 'Deploy tests (shard 8/16)', conclusion: 'failure' },
        { name: 'Deploy tests (shard 1/16)', conclusion: 'success' },
      ],
      lane: 'bun',
    },
    {
      databaseId: 29984259723,
      createdAt: '2026-07-23T06:10:54Z',
      event: 'schedule',
      conclusion: 'failure',
      jobs: [{ name: 'Deploy tests (shard 2/16)', conclusion: 'failure' }],
      lane: 'node',
    },
    {
      databaseId: 30243647123,
      createdAt: '2026-07-27T06:43:12Z',
      event: 'schedule',
      conclusion: 'success',
      jobs: [{ name: 'Deploy tests (shard 1/16)', conclusion: 'success' }],
      lane: 'node',
    },
  ];

  /** Look a row up by run id, throwing rather than silently comparing undefined. */
  function row(rows: ReturnType<typeof classifyRuns>, runId: number) {
    const found = rows.find((r) => r.runId === runId);
    if (!found) throw new Error(`no ledger row for run ${runId}`);
    return found;
  }

  it('extracts the failing SHARD IDs per run', () => {
    const rows = classifyRuns(runs);
    expect(row(rows, 30193384289).failedShards).toEqual(['6/16', '8/16']);
    expect(row(rows, 29984259723).failedShards).toEqual(['2/16']);
    expect(row(rows, 30243647123).failedShards).toEqual([]);
  });

  it('labels every row with the lane it came from', () => {
    const rows = classifyRuns(runs);
    expect(rows.map((r) => r.lane).sort()).toEqual(['bun', 'node', 'node']);
  });

  it('never GUESSES the lane — an unattributable run is reported as unknown, not as node', () => {
    // The lane must come from the run's own evidence (the summary artifact's
    // `runtime`). Inferring it from cron timing is what #545 explicitly warns
    // against; a silent "node" default would launder a bun red into the
    // credential lane's flake rate.
    const rows = classifyRuns([{ ...runs[1], lane: undefined }]);
    expect(row(rows, 29984259723).lane).toBe('unknown');
  });

  it('computes a per-lane flake rate from stable-vs-rotating shard evidence', () => {
    const rows = classifyRuns(runs);
    const node = rows.filter((r) => r.lane === 'node');
    expect(node.filter((r) => r.failedShards.length > 0)).toHaveLength(1);
    expect(node).toHaveLength(2);
  });

  it('renders a queryable table that names the lane and the failing shards', () => {
    const table = renderLedgerTable(classifyRuns(runs));
    expect(table).toContain('bun');
    expect(table).toContain('6/16, 8/16');
    expect(table).toContain('2/16');
  });
});

/**
 * Slice one workflow STEP's text by its `- name:` header, up to the next step
 * or job header. Text-scanned rather than YAML-parsed, matching the deliberate
 * choice in tests/compat-suite-workflow.test.ts (the repo keeps no direct `yaml`
 * dep). Scoping matters: an unscoped file-wide match is how a guard passes while
 * the behaviour it protects is gone.
 */
function sliceStep(name: string): string {
  const start = WORKFLOW.indexOf(`- name: ${name}`);
  expect(start, `workflow step "${name}" not found`).toBeGreaterThan(-1);
  const rest = WORKFLOW.slice(start + 1);
  const end = rest.search(/\n {6}- name:|\n {2}[a-z][a-z-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('#545 AC3 — a re-run cannot erase the signal (workflow contract)', () => {
  it('the red-shard gate prints the named failing tests, not only the counts', () => {
    // Mechanism guard: without this the ONLY record of *which* test failed is
    // the job log, which is what makes "re-run until green" free.
    //
    // SCOPED to the gate STEP, not the whole file. An unscoped /s\.failures/
    // stayed GREEN under mutation because the aggregate ledger job also reads
    // `s.failures` — a textbook decoration guard, caught by the mutation proof.
    const step = sliceStep('Fail shard on red results');
    expect(step).toMatch(/s\.failures/);
    expect(step).toMatch(/s\.notRunFiles/);
  });

  it('the shard summary artifact outlives a 14-night window (retention >= 90 days)', () => {
    // retention-days: 14 could not even cover the v1.0 gate's own 14-run window,
    // so the flake rate was unauditable after the fact by construction.
    // Scoped to the LEDGER artifacts only — the intermediate workspace tarball
    // is deliberately retention-days: 1 (a multi-GB blob, not evidence).
    const ledgerUploads = [
      ...WORKFLOW.matchAll(
        /name:\s*(compat-suite-summary[^\n]*|compat-run-ledger[^\n]*)\n(?:(?!\s*-\s|\s*name:)[^\n]*\n)*?\s*retention-days:\s*(\d+)/g,
      ),
    ];
    expect(ledgerUploads.length).toBeGreaterThanOrEqual(2);
    for (const m of ledgerUploads) expect(Number(m[2])).toBeGreaterThanOrEqual(90);
  });

  it('the nightly red alert carries the failing shard IDs and test names in its body', () => {
    // BOTH halves, or the guard is decoration: renaming only the env wiring left
    // the `${RED_SHARD_DETAIL}` body reference behind and a single-token match
    // stayed green (caught by the mutation proof).
    expect(WORKFLOW).toMatch(
      /RED_SHARD_DETAIL:\s*\$\{\{\s*needs\.shard-ledger\.outputs\.red_detail\s*\}\}/,
    );
    expect(WORKFLOW).toMatch(/\$\{RED_SHARD_DETAIL\}/);
  });

  it('an aggregate ledger job records every shard outcome for the run', () => {
    expect(WORKFLOW).toMatch(/^ {2}shard-ledger:$/m);
  });

  it('the shard step has NO retry/continue-on-error escape hatch (a retry is not a fix)', () => {
    // #545: "The tempting shortcut is a blanket retry on failed shards, which
    // would make the gate permanently green and permanently meaningless."
    expect(WORKFLOW).not.toMatch(/continue-on-error:\s*true/);
    expect(WORKFLOW).not.toMatch(/nick-fields\/retry/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #695 — the ledger must reconcile against the MATRIX, not against whatever
// artifacts arrived.
//
// Run 30790778590 (node lane, 2026-08-03) concluded FAILURE on shard 16/16; that
// job stopped executing steps, so its `if: always()` upload tail never ran and
// `compat-suite-summary-15` never existed. The ledger was assembled from the
// fifteen artifacts that did arrive and recorded a 15-row, all-green night — and
// the ledger job concluded SUCCESS. The job log has since expired, so the only
// surviving evidence of that red night claims it was clean.
//
// The behavioural half of the fix (a missing shard is an ERROR, and a
// no-error ledger is necessarily complete) is pinned in
// tests/compat-run-ledger-completeness.test.ts, against the real module. THIS
// half pins the wiring: the workflow declares the shard total once, the matrix
// agrees with it, and the ledger job may run NOTHING but the audited script —
// stated as an allowlist, so re-inlining the computation in any shape fails
// rather than only the one spelling somebody thought to ban.
// ─────────────────────────────────────────────────────────────────────────────

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}
interface WorkflowJob {
  if?: unknown;
  steps?: WorkflowStep[];
  strategy?: { matrix?: { shard?: unknown } };
}
interface WorkflowDoc {
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const DOC = parse(WORKFLOW) as WorkflowDoc;

function job(id: string): WorkflowJob {
  const found = DOC.jobs?.[id];
  if (!found) throw new Error(`workflow job "${id}" not found`);
  return found;
}

/**
 * The ONE `if:` expression any part of the ledger job may carry.
 *
 * `always()` is load-bearing at job level (the ledger must be built when
 * `deploy-tests` fails) and on the upload step (an INCOMPLETE ledger is the
 * evidence, so it must be uploaded on the failing path). Every other
 * expression — `${{ false }}`, `success()`, an event condition — can stop the
 * gate from running, and a step that does not run cannot fail. Allowlist of
 * one, normalised for the `${{ }}` wrapper and whitespace.
 */
const ADMISSIBLE_IF = /^(always\(\)|\$\{\{\s*always\(\)\s*\}\})$/;

/**
 * The ONE command the ledger job may run. Shared by the command allowlist and
 * by `ledgerStep()`, so "the audited step" and "the step the allowlist checks"
 * cannot drift into being two different steps.
 */
const LEDGER_RUN_ALLOWLIST = [/^node knext\/scripts\/compat-run-ledger\.mjs$/];

/** Job keys the ledger job may carry. Anything else is reported, not ignored. */
const LEDGER_JOB_KEYS = new Set([
  'name',
  'needs',
  'if',
  'runs-on',
  'timeout-minutes',
  'outputs',
  'steps',
]);

/**
 * Step keys the AUDITED step may carry.
 *
 * `env` is allowed but its contents are allowlisted below; `working-directory`
 * is deliberately absent — it relocates the ledger file the `if: always()`
 * upload is pointed at, without changing the `run:` string the command
 * allowlist matches.
 */
const LEDGER_STEP_KEYS = new Set(['name', 'id', 'env', 'run']);

/**
 * Env keys the audited step may carry.
 *
 * `OUT_FILE`, `SUMMARY_DIR` and `FINGERPRINT_FILE` are read by
 * scripts/compat-run-ledger.mjs and each one redirects the evidence or its
 * inputs; they are excluded by being absent, not by being named, so a fourth
 * such knob added to the script is reported here too.
 */
const LEDGER_STEP_ENV_KEYS = new Set(['RUN_ID', 'RUN_ATTEMPT', 'EVENT_NAME']);

/** The audited step: the one whose `run:` is the sanctioned ledger command. */
function ledgerStep(): WorkflowStep {
  const step = (job('shard-ledger').steps ?? []).find((s) =>
    LEDGER_RUN_ALLOWLIST.some((rx) => rx.test(String(s.run ?? '').trim())),
  );
  if (!step) throw new Error('no step in shard-ledger runs the sanctioned ledger command');
  return step;
}

/**
 * Everything that could make `shard-ledger` conclude success on a red night
 * WITHOUT touching the `run:` string — collected as findings rather than
 * asserted one at a time, so the message names every problem at once.
 */
function auditLedgerJob(): string[] {
  const problems: string[] = [];
  const jobId = 'shard-ledger';
  const j = job(jobId) as unknown as Job;

  const jobIf = j.if;
  if (jobIf !== undefined && !ADMISSIBLE_IF.test(String(jobIf).trim())) {
    problems.push(
      `job \`${jobId}\` carries if: ${JSON.stringify(jobIf)} — only \`always()\` is admissible; anything else can condition the gate off, and a skipped job does not fail the run`,
    );
  }
  const jobCoe = continueOnErrorProblem(j, `job \`${jobId}\``);
  if (jobCoe) problems.push(jobCoe);

  for (const key of Object.keys(j)) {
    if (!LEDGER_JOB_KEYS.has(key)) {
      problems.push(
        `job \`${jobId}\` carries the unrecognised job-level key \`${key}\` — this audit fails closed: either it cannot neutralise the gate (add it to LEDGER_JOB_KEYS with a reason) or it can`,
      );
    }
  }

  const steps = j.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push(`job \`${jobId}\` has no steps — it cannot be running anything`);
    return problems;
  }

  // Scanned over EVERY step, not just the audited one: a `continue-on-error` on
  // the download step swallows the fingerprint floor just as effectively.
  steps.forEach((raw, i) => {
    const step = raw as WorkflowStep & Job;
    const label = `job \`${jobId}\` step ${step.name ? `\`${step.name}\`` : `#${i + 1}`}`;
    if (step.if !== undefined && !ADMISSIBLE_IF.test(String(step.if).trim())) {
      problems.push(
        `${label} carries if: ${JSON.stringify(step.if)} — only \`always()\` is admissible; a skipped step writes no ledger, and \`if-no-files-found\` defaults to \`warn\`, so the upload stays green over nothing`,
      );
    }
    const coe = continueOnErrorProblem(step, label);
    if (coe) problems.push(coe);
  });

  // The audited step additionally may not be relocated (Finding 3).
  const audited = ledgerStep() as WorkflowStep & Job;
  for (const key of Object.keys(audited)) {
    if (!LEDGER_STEP_KEYS.has(key)) {
      problems.push(
        `the audited ledger step carries the unrecognised key \`${key}\` — fails closed: it may relocate or neutralise the evidence (add it to LEDGER_STEP_KEYS with a reason)`,
      );
    }
  }
  for (const key of Object.keys((audited.env ?? {}) as Record<string, unknown>)) {
    if (!LEDGER_STEP_ENV_KEYS.has(key)) {
      problems.push(
        `the audited ledger step sets env \`${key}\` — fails closed: scripts/compat-run-ledger.mjs reads OUT_FILE/SUMMARY_DIR/FINGERPRINT_FILE, each of which points the evidence somewhere the upload does not look (add it to LEDGER_STEP_ENV_KEYS with a reason)`,
      );
    }
  }

  return problems;
}

/** The declared shard total, as the workflow states it — parsed, never assumed. */
function declaredShardTotal(): number {
  const raw = DOC.env?.COMPAT_SHARD_TOTAL;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`workflow env COMPAT_SHARD_TOTAL is not a positive integer: ${String(raw)}`);
  }
  return n;
}

describe('#695 — the ledger reconciles against the declared shard total', () => {
  it('the workflow declares COMPAT_SHARD_TOTAL exactly once, at workflow level', () => {
    expect(() => declaredShardTotal()).not.toThrow();
    // Exactly once: two declarations are two facts, and the ledger would read
    // whichever won. Counted over the raw text so a job-level or step-level
    // re-declaration is caught, not just a second top-level key.
    const occurrences = WORKFLOW.match(/^\s*COMPAT_SHARD_TOTAL:/gm) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('the deploy-tests matrix IS the declared total — derived, never eyeballed', () => {
    const total = declaredShardTotal();
    const matrix = job('deploy-tests').strategy?.matrix?.shard;
    expect(Array.isArray(matrix)).toBe(true);
    // Derived from the declared total rather than written out: an enumerated
    // expectation is how the sixteenth entry gets missed.
    expect(matrix).toEqual(Array.from({ length: total }, (_, i) => `${i + 1}/${total}`));
  });

  it('the ledger job runs the audited script — and NOTHING else (allowlist)', () => {
    const allowed = LEDGER_RUN_ALLOWLIST;
    // The allowlist is the point. Banning one spelling of an inline
    // implementation ("no heredoc") leaves every other spelling working; this
    // permits one exact command and fails everything else, including a
    // re-inlined `node <<EOF`, a `|| true`, or a second computation appended
    // after the sanctioned one.
    const runs = (job('shard-ledger').steps ?? [])
      .map((s) => s.run)
      .filter((r): r is string => typeof r === 'string');

    // Non-vacuity: a job with no `run:` steps would satisfy any allowlist.
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const command = run.trim();
      expect(
        allowed.some((rx) => rx.test(command)),
        `unsanctioned command in the shard-ledger job:\n${command}`,
      ).toBe(true);
    }
  });

  it('the ledger job checks the repo out, so the script it runs exists', () => {
    const steps = job('shard-ledger').steps ?? [];
    const checkout = steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
    expect(checkout, 'the shard-ledger job never checks out knext').toBeTruthy();
    expect(checkout?.with?.path).toBe('knext');
  });

  it('the uploaded artifact is the file the script writes (one fact, not two)', () => {
    const upload = (job('shard-ledger').steps ?? []).find(
      (s) => String(s.uses ?? '').startsWith('actions/upload-artifact@') && s.with?.name,
    );
    expect(upload?.with?.name).toBe('compat-run-ledger');
    expect(upload?.with?.path).toBe(DEFAULT_OUT_FILE);
    // The ledger must be uploaded even when the reconciliation FAILS the job —
    // an incomplete ledger is the evidence, so losing it on red is the same
    // hole in a different place.
    expect(upload?.if).toBe('always()');
  });

  it('the ledger job cannot be skipped or made unfailable', () => {
    // ────────────────────────────────────────────────────────────────────────
    // The allowlist above guards what the step RUNS. It says nothing about
    // whether the step runs at all, or whether its failure can fail the job —
    // and four one-line edits left the whole suite green while `shard-ledger`
    // concluded SUCCESS on a red night:
    //
    //   if: ${{ false }}                 (step)  → step skipped, no ledger
    //                                              written, `if: always()`
    //                                              upload finds no file
    //                                              (if-no-files-found: warn),
    //                                              job GREEN
    //   continue-on-error: ${{ true }}   (step)  → failure cannot fail the job
    //   continue-on-error: 'true'        (step)  → same, quoted scalar
    //   continue-on-error: ${{ true }}   (job)   → same, one level up
    //
    // Only the bare literal `continue-on-error: true` was caught, by the
    // file-wide text guard above — and this repo had ALREADY written the
    // expression form down as that regex's known evasion
    // (tests/ci-concurrency-group.test.ts, tests/bun-exec-alpine-image-ci.test.ts).
    // Banning spellings is what fails; asking "is it literally `false`?" is
    // what holds, which is why `continueOnErrorProblem` is imported rather than
    // re-implemented here.
    //
    // Everything below is an ALLOWLIST that fails closed: an unrecognised key
    // is a finding, so a neutralising key nobody thought of is reported rather
    // than ignored. Adding one is a deliberate act with a reason attached.
    // ────────────────────────────────────────────────────────────────────────
    const problems = auditLedgerJob();
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('the audited step cannot be redirected away from the evidence path', () => {
    // Finding 3: the `run:` string is what the allowlist matches, so
    // `working-directory: /tmp` on the step, or `OUT_FILE: /tmp/ledger.json` in
    // its `env:`, both leave the ledger somewhere the `if: always()` upload
    // never looks — guards green, evidence gone. The step's key set and its env
    // key set are therefore allowlisted too (asserted by `auditLedgerJob`,
    // exercised here against the two concrete redirections).
    const step = ledgerStep();
    expect(Object.keys(step)).not.toContain('working-directory');
    expect(Object.keys(step.env ?? {})).not.toContain('OUT_FILE');
    expect(auditLedgerJob()).toEqual([]);
  });

  it('the red alert fires when the ledger or the shards are CANCELLED, not only failed', () => {
    // The residual this PR shrank rather than closed: a job-level timeout or a
    // runner loss makes `result == 'cancelled'`, which `== 'failure'` misses —
    // so total silence was still reachable one level up from the ledger. Same
    // principle as the ledger itself: silence and success must not look alike.
    const alert = DOC.jobs?.['nightly-red-alert'];
    const condition = String(alert?.if ?? '');
    expect(condition).toMatch(/needs\.shard-ledger\.result\s*==\s*'cancelled'/);
    expect(condition).toMatch(/needs\.deploy-tests\.result\s*==\s*'cancelled'/);
  });

  it('nothing else in the workflow writes the ledger file', () => {
    // The other half of the allowlist: a second writer anywhere in the file
    // would produce a ledger that never met the reconciliation. Every mention
    // of the artifact filename must be a comment or the upload path.
    const offenders = WORKFLOW.split('\n').filter(
      (line) =>
        line.includes(`${DEFAULT_OUT_FILE}`) &&
        !/^\s*#/.test(line) &&
        !new RegExp(`^\\s*path:\\s*${DEFAULT_OUT_FILE}\\s*$`).test(line),
    );
    expect(offenders, `unsanctioned writer(s) of ${DEFAULT_OUT_FILE}`).toEqual([]);
  });
});
