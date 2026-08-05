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
 * The PR-triggering keys this classifier answers about.
 *
 * `pull_request_target` is IN SCOPE, deliberately: it is the more dangerous of
 * the two — it runs with the BASE repository's secrets and write-scoped token —
 * so a guard exempted on the grounds of "no `pull_request` trigger" while its
 * workflow runs unconditionally on `pull_request_target` is the same silent
 * exemption on the trigger that matters more.
 */
const PR_TRIGGER_KEYS = ['pull_request', 'pull_request_target'] as const;

/**
 * `on:` has THREE syntaxes and only one of them is a mapping (#676 round 4).
 *
 * GitHub accepts `on: pull_request` (scalar) and `on: [pull_request, push]`
 * (sequence) as well as the block mapping every workflow in this repo happens to
 * use today. Testing `'pull_request' in on` against the raw parse therefore
 * MISSES two of the three forms — measured: rewriting `docs-closure-nightly.yml`
 * into either form left the "no `pull_request` trigger" exemption GREEN while
 * the workflow had become an unconditional PR gate.
 *
 * So normalise first: every form becomes a map from trigger name to its filter
 * block (`undefined` where the form cannot carry one, which is exactly what
 * unconditional means).
 *
 * POLARITY, because the identical `'pull_request' in on` test at the bottom of
 * `auditBlockingGate` is NOT this bug: there a missing trigger is REPORTED as a
 * problem, so mis-reading a list form fails safe (over-strict on a form no
 * workflow here uses). Inside an EXEMPTION checker the same code fails UNSAFE,
 * because "absent" flips meaning from "flag this" to "wave this through". Same
 * pattern, correct in one context and wrong in the other.
 */
function normalizeTriggers(on: unknown): Map<string, unknown> {
  const triggers = new Map<string, unknown>();
  if (typeof on === 'string') {
    triggers.set(on, undefined);
  } else if (Array.isArray(on)) {
    for (const entry of on) if (typeof entry === 'string') triggers.set(entry, undefined);
  } else if (on !== null && typeof on === 'object') {
    for (const [key, value] of Object.entries(on as Record<string, unknown>)) {
      triggers.set(key, value);
    }
  }
  return triggers;
}

/** One trigger's filter block, classified. */
function classifyFilters(filters: unknown): TriggerShape {
  if (filters === undefined || filters === null || typeof filters !== 'object') {
    return 'unconditional-pull-request';
  }
  const record = filters as Record<string, unknown>;
  const keys = Object.keys(record).filter(
    (key) => !(key === 'branches' && isUniversalBranchFilter(record[key])),
  );
  if (keys.length === 0) return 'unconditional-pull-request';
  if (keys.every((key) => key === 'paths' || key === 'paths-ignore')) {
    return 'paths-scoped-pull-request';
  }
  return 'otherwise-filtered-pull-request';
}

/**
 * How exempt-able each shape is. When a workflow carries BOTH `pull_request` and
 * `pull_request_target`, the LEAST exempt one wins — a `paths:`-scoped
 * `pull_request` must not launder an unconditional `pull_request_target` beside
 * it.
 */
const SHAPE_SEVERITY: Record<TriggerShape, number> = {
  'unconditional-pull-request': 0,
  'otherwise-filtered-pull-request': 1,
  'paths-scoped-pull-request': 2,
  'no-pull-request-trigger': 3,
};

/**
 * Classify a workflow's pull-request trigger.
 *
 * Deliberately narrower than `auditBlockingGate`'s trigger half, which asks "can
 * this gate be skipped" and so fails closed on every filter key. This asks the
 * triage's question — "is the recorded reason for exempting this guard the real
 * one" — and therefore has to tell a `paths:` filter apart from a `branches:`
 * one rather than collapsing both to "has a problem".
 */
export function classifyTriggerShape(workflowPath: string): TriggerShape {
  const doc = parse(readFileSync(workflowPath, 'utf8')) as Record<string, unknown> | null;
  const triggers = normalizeTriggers(doc?.on ?? doc?.[true as unknown as string]);

  let shape: TriggerShape = 'no-pull-request-trigger';
  for (const key of PR_TRIGGER_KEYS) {
    if (!triggers.has(key)) continue;
    const candidate = classifyFilters(triggers.get(key));
    if (SHAPE_SEVERITY[candidate] < SHAPE_SEVERITY[shape]) shape = candidate;
  }
  return shape;
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

/**
 * A WORKFLOW-level `concurrency` block reaches every job in the file, including
 * an audited gate — so #674, which adds one to `ci.yml` where two audited gates
 * live, would otherwise have slipped past this audit entirely. `concurrency` is
 * absent from `ALLOWED_JOB_KEYS` for exactly this reason at job level; the
 * workflow level had no equivalent check at all.
 *
 * The question is not "is there a group" but "can anything OTHER than a
 * superseding push to this same ref cancel the gate":
 *
 *   - a REF-SCOPED cancelling group is safe. Its only canceller is a newer
 *     commit on the same PR, which starts a fresh run whose gates must go green
 *     on the new head SHA. Nothing is disarmed; the superseded run's result was
 *     about a SHA that is no longer the head.
 *   - a group that is not ref-scoped (a fixed string, or keyed only on
 *     `github.workflow`) can be tripped by an UNRELATED ref, so one PR's push
 *     cancels another PR's gate run. A cancelled check is not a failed check,
 *     and that is the disarm.
 *
 * `github.head_ref` and a PR-number key are accepted as ref scoping for the same
 * reason `github.ref` is: all three vary per pull request.
 *
 * The interpolation body must be EXACTLY one of those contexts, and that
 * strictness is the round-2 fix. The first version was
 * `/\$\{\{[^}]*github\.(ref|ref_name|head_ref)[^}]*\}\}|pull_request\.number/`
 * — "an interpolation CONTAINING `github.ref` somewhere" — which was measured to
 * accept three groups that scope nothing:
 *
 *   - `ci-${{ github.ref_protected }}` — a BOOLEAN. Two buckets for the whole
 *     repository, so every PR shares a group with roughly half the others;
 *   - `ci-${{ github.ref == 'refs/heads/main' }}` — also a boolean, and it reads
 *     more like ref scoping than the last one;
 *   - the bare literal `pull_request.number` — no `${{ }}` at all, because the
 *     second alternation was unanchored. A fixed string scopes nothing, and it
 *     is the fixed-string case this function exists to reject, accepted by the
 *     branch meant to permit PR scoping.
 *
 * Each collapses every PR into one group, i.e. exactly the cross-PR disarm, in a
 * check documented as failing closed. So this enumerates the contexts that DO
 * vary per pull request and rejects everything else, including an expression
 * over one of them — a comparison's value is not its operand.
 *
 * ROUND 3: "exactly one context" was too strict, and being too strict here is
 * not a safe error. It rejected the canonical GitHub idiom — measured,
 * `${{ github.head_ref || github.ref }}` and
 * `${{ github.event.pull_request.number || github.ref }}` both returned false —
 * and `.github/workflows/preview.yml:47` already uses that shape. It does not
 * red today only because `preview.yml` carries no audited gate; when one lands,
 * the guard would report a CORRECTLY scoped group as "not scoped to the ref",
 * and editing the guard becomes the natural fix. That is the antipattern
 * `workflow.md` names, so the guard is the thing that has to be right.
 *
 * The distinction that makes both rounds correct at once is OPERAND FALLBACK vs
 * VALUE COMPUTATION. `a || b` in a GitHub expression evaluates to `a` or to `b`
 * — its value IS one of its operands, so if every operand varies per PR, so does
 * the result. `a == b` evaluates to a BOOLEAN that is not either operand, which
 * is why `${{ github.ref == 'refs/heads/main' }}` collapses and stays rejected.
 */

/** Contexts whose value provably differs between two open pull requests. */
const PER_PR_CONTEXTS = [
  'github.ref',
  'github.ref_name',
  'github.head_ref',
  'github.event.pull_request.number',
] as const;

const PER_PR_OPERAND = new Set<string>(PER_PR_CONTEXTS);

/**
 * Admissible only as a LATER operand, never alone.
 *
 * `github.event.inputs.*` is an arbitrary user-supplied `workflow_dispatch`
 * string. As `preview.yml`'s fallback behind a real PR number it is fine; on its
 * own it can be a constant (an environment name, an input default), which is the
 * every-ref-in-one-group collapse this function exists to reject. The permissive
 * direction is the one that costs something, so it is gated on at least one
 * genuine per-PR operand being present.
 */
const DISPATCH_INPUT = /^github\.event\.inputs\.[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Does this `${{ }}` body evaluate to a value that differs per pull request?
 *
 * Split on `||` only. `&&` is deliberately absent: `a && b` evaluates to `b`
 * when `a` is truthy, so its value does not follow from all operands varying,
 * and no workflow here uses it in a group.
 */
function bodyIsPerPr(body: string): boolean {
  const operands = body.split('||').map((s) => s.trim());
  if (operands.some((o) => o.length === 0)) return false;
  const admissible = operands.every((o) => PER_PR_OPERAND.has(o) || DISPATCH_INPUT.test(o));
  return admissible && operands.some((o) => PER_PR_OPERAND.has(o));
}

/** Is any interpolation in this group string a per-PR value? */
function isRefScopedGroup(group: string): boolean {
  const bodies = [...group.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1] as string);
  return bodies.some(bodyIsPerPr);
}

function concurrencyProblem(container: Job, where: string): string | null {
  if (!('concurrency' in container)) return null;
  const value = container.concurrency;
  // The shorthand string form sets a group only; it queues, it never cancels.
  if (typeof value === 'string') return null;
  if (value === null || typeof value !== 'object') return null;
  const block = value as Record<string, unknown>;
  // Every form except a literal `false`/absent counts as cancelling — the same
  // inversion `continue-on-error` uses, so `${{ true }}` is not a hiding place.
  if (!('cancel-in-progress' in block) || block['cancel-in-progress'] === false) return null;
  const group = typeof block.group === 'string' ? block.group : '';
  if (isRefScopedGroup(group)) return null;
  // The message names what IS accepted. "not scoped to the ref" alone was a
  // claim the guard could not back — false for every `||` form above — and a
  // message that misdescribes the defect is how a reader learns to edit the
  // guard instead of the workflow.
  return `${where} carries a cancelling \`concurrency\` group (${JSON.stringify(group)}) in which no interpolation evaluates to a per-PR value, so an unrelated ref can cancel this gate and a cancelled check is not a failed check — accepted: \`\${{ <ctx> }}\` or an \`||\` chain of them, where <ctx> is one of ${PER_PR_CONTEXTS.join(', ')} (a \`github.event.inputs.*\` fallback is allowed behind one of those)`;
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

  // The workflow-level `concurrency` half (#674). Job-level `concurrency` is
  // already reported by the fail-closed allowlist; this is the one that reaches
  // the gate from outside the job definition.
  const concurrency = concurrencyProblem(doc as Job, `${workflowPath} (workflow-level)`);
  if (concurrency) problems.push(concurrency);

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
