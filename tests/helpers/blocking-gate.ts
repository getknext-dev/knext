import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * `typecheck-root`, and `lint-and-test` (the mutation-residue scan's step) —
 * plus, since #677, `resolve-image-pins` in `image-pin-resolution-nightly.yml`,
 * the one PR-triggered gate that is deliberately `paths:`-scoped.
 * `scripts/mutation-prove-ci-blocking-gates.mjs` disarms all six, five ways.
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
 *   - PR-TRIGGERED BUT DELIBERATELY `paths:`-SCOPED — EMPTY since #677, and the
 *     emptying is the point rather than a tidy-up. The one entry it ever held,
 *     `tests/operator-image-pin-resolution.test.ts`
 *     (image-pin-resolution-nightly.yml), was a LIVE #661 instance: its guard
 *     asked the blocking question as text on a workflow that DOES run on pull
 *     requests, and the byte-snapshot harness measured it GREEN under all five
 *     disarms. The exemption's stated ground — "a paths-scoped run is not the
 *     unconditional gate this audit certifies" — was true of the audit as it
 *     then stood, so the audit is what changed: `allowPathsFilter` (see
 *     `BlockingGateOptions`) lets a caller opt into a `paths:` filter, and
 *     ONLY that, while the caller separately asserts the filter's contents cover
 *     what its gate protects. The category stays in the type because the
 *     classifier still reports the shape, but a paths-scoped trigger is no
 *     longer sufficient grounds for an exemption: convert with the option
 *     instead.
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
 * filter. That entry is GONE as of #677 — its guard is converted, with
 * `allowPathsFilter` — but the episode is why this list is data: a wrong reason
 * in a self-reported exemption list is exactly the silent-exemption shape
 * `workflow.md` says to watch for, and it survived two rounds of reading.
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
  /**
   * Opt in to a `paths:`-scoped `pull_request` trigger (#677).
   *
   * OFF by default, and the default is the important half: this audit's whole
   * claim is "the gate runs on every PR", and a `paths:` filter means it does
   * not. The option exists because ONE gate here is deliberately scoped —
   * `image-pin-resolution-nightly.yml` resolves pins against an anonymous,
   * per-source-IP rate-limited registry, so an unscoped run would put a third
   * party in front of every merge and a flaky gate trains people to bypass it.
   * Without a mode, that guard could not use this audit at all, and it stayed on
   * the evadable text form for two rounds for exactly that reason.
   *
   * WHAT IT DOES NOT DO, because "a documented mode" is how a relaxation becomes
   * a hole:
   *   - it exempts `paths` ONLY. `paths-ignore`, `branches`, `types` and any
   *     unrecognised key still fail closed. In particular `paths-ignore` is an
   *     EXCLUSION — nothing about it can be checked for coverage — so it is not
   *     the same claim and is not covered here.
   *   - it REJECTS an empty `paths:` list, which the un-optioned audit never had
   *     to consider: an allowlist that matches nothing is a gate that never
   *     runs, i.e. the disarm this option could otherwise introduce.
   *
   * The other half is the CALLER'S, and it is not enforceable from here: a
   * paths-scoped gate is only honest if the filter's contents cover everything
   * the gate protects. `auditBlockingGate` returns `pullRequestPaths` so the
   * caller can assert that against its own subject —
   * `tests/operator-image-pin-resolution.test.ts` compares each glob against
   * every file `discoverSources()` walks.
   */
  allowPathsFilter?: boolean;
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
  /**
   * The `pull_request` trigger's `paths:` globs, empty when there are none.
   *
   * Returned so a caller using `allowPathsFilter` can assert the filter's
   * CONTENTS cover what its gate protects — the half this audit cannot know,
   * because only the caller knows the gate's subject.
   */
  pullRequestPaths: string[];
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

/**
 * Contexts whose value differs between two open pull requests.
 *
 * FORK-PR CAVEAT ON `github.head_ref`, decided rather than inherited (#679).
 *
 * `github.head_ref` is the head BRANCH NAME, not a repository-qualified ref, so
 * two pull requests from different FORKS whose branches are both named `patch-1`
 * share it — and with `cancel-in-progress`, one would cancel the other's gate
 * run. A cancelled check is not a failed check, which is the exact disarm
 * `concurrencyProblem` exists to reject. The same holds for the canonical
 * `${{ github.head_ref || github.ref }}` idiom, because on a `pull_request`
 * event `head_ref` is non-empty and `||` therefore yields IT, not `github.ref`.
 *
 * DECISION: `head_ref` stays accepted. Measured before deciding, on
 * `getknext-dev/knext`: 0 forks, and 0 of the 407 pull requests ever opened were
 * cross-repository — so no fork PR has ever run these gates. And the collision
 * is theoretical HERE for a second, independent reason: **no workflow in this
 * repo scopes a concurrency group on `head_ref` at all** (`grep -rn head_ref
 * .github/workflows/` returns nothing), so there is no group for a fork to
 * collide on. Rejecting it would tighten a rule that no workflow exercises.
 *
 * ROUND 2 (#681) CORRECTS THE RECORD, not the decision. Round 1 justified
 * acceptance with a claim that is FALSE: that rejecting `head_ref` "would red
 * the canonical idiom that `.github/workflows/preview.yml:47` already uses".
 * `preview.yml:47` is `preview-${{ github.event.pull_request.number ||
 * github.event.inputs.pr }}` — no `head_ref` in it. The line above at "ROUND 3"
 * is the correct one: what `preview.yml:47` shares is the `X || dispatch-input`
 * FALLBACK SHAPE, and round 1 silently upgraded that to `head_ref ||
 * github.ref`, a different claim the repo does not support. A comment asserting
 * something the tree does not back is the defect class this very PR deletes
 * elsewhere, so the stated cost of the tightening is withdrawn: it does not
 * exist, and the decision rests on the two measured facts above instead.
 *
 * WHAT WOULD REOPEN IT, stated so the decision is falsifiable rather than
 * permanent: the repo gaining forks (`gh repo view --json forkCount`) or its
 * first cross-repository PR, while an AUDITED gate's group rests on `head_ref`.
 * No audited gate does today — `ci.yml:42` keys on `github.ref`, which on a
 * `pull_request` event is `refs/pull/<n>/merge` and is unique per PR even across
 * forks. `github.event.pull_request.number` is likewise collision-free; both are
 * the scoping to prefer when writing a new group.
 *
 * HOW MUCH OF THAT IS ENFORCED — half, and the half is named rather than left
 * to read as a gate:
 *
 *   - ENFORCED. "No group here rests on `head_ref`" is a tripwire, not a
 *     sentence: `tests/ci-concurrency-group.test.ts` scans every workflow-level
 *     and job-level `concurrency.group` and reds on the first `head_ref`. It
 *     does not forbid one — this function still accepts it deliberately — it
 *     forces whoever lands one to re-take this decision instead of inheriting
 *     it.
 *   - NOT ENFORCED, no owner, no check. The fork half. `forkCount` and
 *     "has a cross-repository PR ever been opened" are external state that no
 *     offline test can read, and this repo's own rule is that a documented
 *     expectation degrades and its efficacy is unobservable until it has
 *     already failed. That applies here, to this paragraph.
 */
const PER_PR_CONTEXTS = [
  'github.ref',
  'github.ref_name',
  'github.head_ref',
  'github.event.pull_request.number',
] as const;

const PER_PR_OPERAND = new Set<string>(PER_PR_CONTEXTS);

/**
 * Admissible, but never sufficient on its own.
 *
 * `github.event.inputs.*` is an arbitrary user-supplied `workflow_dispatch`
 * string. As `preview.yml`'s fallback behind a real PR number it is fine; on its
 * own it can be a constant (an environment name, an input default), which is the
 * every-ref-in-one-group collapse this function exists to reject. The permissive
 * direction is the one that costs something, so it is gated on at least one
 * genuine per-PR operand being present.
 *
 * POSITION IS NOT ENFORCED, and this comment used to say it was ("admissible
 * only as a LATER operand, never alone"). Measured: `bodyIsPerPr` accepts
 * `${{ github.event.inputs.env || github.ref }}` — a dispatch input FIRST — the
 * same as the other order, because the rule is a count over the operand set, not
 * an order over it. Harmless in practice (inputs are empty on `pull_request`,
 * and this audit requires that trigger), but a comment asserting a constraint
 * the code does not enforce is the defect class #675 spent three rounds on, so
 * the claim is gone rather than restated more carefully.
 */
const DISPATCH_INPUT = /^github\.event\.inputs\.[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Does this `${{ }}` body evaluate to a value that differs per pull request?
 *
 * Split on `||` only. `&&` is deliberately absent: `a && b` evaluates to `b`
 * when `a` is truthy, so its value does not follow from all operands varying,
 * and no workflow here uses it in a group. That omission is now PINNED by a
 * negative test ("rejects an `&&` chain", #679) and mutation-proved — splitting
 * on `&&` flips `${{ github.head_ref && github.ref }}` from rejected to
 * accepted, so "fixing" the apparent inconsistency with `||` silently widens the
 * rule.
 *
 * There is no separate empty-operand guard, and its absence is deliberate
 * (#679): an empty operand is in neither admissible set, so `every` already
 * returns false. Removing the guard that said so changed ZERO of the 37 review
 * outcomes, and a branch that cannot change an outcome reads as a rule when it
 * is really a restatement.
 */
function bodyIsPerPr(body: string): boolean {
  const operands = body.split('||').map((s) => s.trim());
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
 *
 * EXPORTED (#693) because `auditBlockingGate`'s two halves have different
 * audiences. The TRIGGER half certifies a job as an unconditional PR gate, which
 * a deliberately-scheduled nightly is not and must not be described as. This
 * half — job-level `if:`, `continue-on-error` at job and step level, an
 * unrecognised job key, and the same walk over the transitive `needs:` closure —
 * applies to ANY job whose failure must fail its run, including a nightly's.
 * `.github/workflows/mutation-prover-nightly.yml` took the first half's
 * inapplicability as licence to skip both, and a job-level `if:` on its lane job
 * would have made the lane skip silently AND suppressed its own red alert
 * (`needs.<job>.result` is then `'skipped'`, never `'failure'`).
 */
export function auditJobCanNotSkip(
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
 * A GitHub `paths:` glob as a RegExp over repo-relative POSIX paths.
 *
 * `**` crosses `/` (and may match zero directories); `*` and `?` do not. Lifted
 * here from `tests/operator-image-pin-resolution.test.ts` (#690) so the audit and
 * that spec's walk-coverage assertion share ONE translation — two of them could
 * only diverge.
 *
 * Do NOT read that spec's `it('the glob translation itself is right')` as coverage
 * for the audit: measured, breaking the bare-`**` branch leaves that spec 26/26
 * GREEN: it exercises the `**`-followed-by-slash form, `*` and `.`-escaping, and
 * never a bare `**` or a `?`. Those two branches are covered by the audit
 * fixtures in `tests/blocking-gate-helper.test.ts`, and that is where to add more.
 *
 * KNOWN GAP, now load-bearing in a REFUSAL path: character classes are not
 * translated — `[abc]` is escaped to a literal — so a real glob such as
 * `scripts/verify-image-[p]ins.mjs` is reported as matching no tracked file.
 * Pre-existing in the lifted implementation; the vacuity check gave it a new
 * blast radius. Widen the translation before writing a pin that needs one.
 */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:[^/]+/)*';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}$`);
}

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

let trackedFilesCache: string[] | null = null;

/**
 * Every tracked path, once per process.
 *
 * A `git` that cannot run THROWS, which surfaces as a red test — deliberately.
 * An audit that silently treated "I could not list the files" as "the filter is
 * fine" would be the unreachable-API-is-a-pass failure `security.md` names.
 */
function trackedFiles(): string[] {
  if (trackedFilesCache) return trackedFilesCache;
  trackedFilesCache = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  return trackedFilesCache;
}

/**
 * Everything that makes a `paths:` filter VACUOUS — a filter that matches
 * nothing is a gate that never runs (#690).
 *
 * The first version of this option checked `value.length === 0` and nothing
 * else, which is why `paths: ['']`, `paths: ['   ']` and
 * `paths: ['no/such/dir/**']` all passed the audit while being exactly the
 * disarm the option promises to refuse. Leaning on the CALLER to catch those was
 * an obligation stated in prose, and a documented expectation degrades; the
 * cheapest fix is for the audit to refuse them itself, so the caller's remaining
 * obligation is the one thing only the caller can know — that the filter COVERS
 * what its gate protects.
 *
 * WHAT IS DELIBERATELY NOT CHECKED, because it was MEASURED to be wrong: a
 * PER-GLOB "this one matches no tracked file" rule. It reports
 * `benchmarks/**\/*.yml` as dead scope, and that is a false positive —
 * `verify-image-pins.mjs` accepts `/\.(ya?ml|sh)$/` under `benchmarks/`, so a
 * `.yml` benchmark WOULD be scanned; the repo simply has none today. A check
 * that cannot tell "future scope the walk already accepts" from "scope the gate
 * does not have" makes deleting a correct glob the way back to green. The
 * LIST-level form has no such failure mode: a filter where NOT ONE glob matches
 * any tracked file cannot be future scope, it is a gate that never fires.
 */
function vacuousPathsProblems(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [
      `the \`pull_request\` trigger's \`paths\` filter is empty (${JSON.stringify(value)}) — an allowlist that matches nothing means this gate never runs`,
    ];
  }
  const problems: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      problems.push(
        `the \`pull_request\` trigger's \`paths\` filter carries the vacuous entry ${JSON.stringify(entry)} — an empty or blank glob matches nothing`,
      );
    }
  }
  const globs = value.filter((e): e is string => typeof e === 'string' && e.trim() !== '');
  if (globs.length > 0) {
    const patterns = globs.map((g) => globToRegExp(g.trim()));
    const matchesSomething = trackedFiles().some((file) => patterns.some((re) => re.test(file)));
    if (!matchesSomething) {
      problems.push(
        `the \`pull_request\` trigger's \`paths\` filter (${JSON.stringify(globs)}) matches NO tracked file — a filter nothing satisfies is a gate that never runs`,
      );
    }
  }
  return problems;
}

/**
 * Audit `jobId` in `workflowPath` as a blocking, always-runs-on-PR gate.
 *
 * Returns problems rather than throwing so the caller can assert on the whole
 * list at once (and so a failure names every defect, not just the first).
 */
export function auditBlockingGate(options: BlockingGateOptions): BlockingGateAudit {
  const { workflowPath, jobId, gateCommand, allowPathsFilter = false } = options;
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
      pullRequestPaths: [],
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
      // The one caller-opted exemption (#677), narrowed three times: `paths`
      // only — never `paths-ignore`, which is an exclusion and so states no
      // coverage — never an EMPTY list, and (#690) never a list that is VACUOUS
      // in the ways an empty one is: see `vacuousPathsProblems`.
      if (key === 'paths' && allowPathsFilter) {
        problems.push(...vacuousPathsProblems((pr as Record<string, unknown>).paths));
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

  const prPaths =
    pr !== null && typeof pr === 'object' ? (pr as Record<string, unknown>).paths : undefined;

  return {
    problems,
    jobsSeen: Object.keys(jobs).length,
    gateStepsSeen: gateSteps.length,
    needsClosure,
    pullRequestPaths: Array.isArray(prPaths) ? prPaths.map(String) : [],
  };
}
