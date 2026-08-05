import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

/**
 * GUARD TESTS for GitHub Actions `concurrency` (#674).
 *
 * ## Why this exists
 *
 * #673 fixed `ci.yml`'s `pull_request: branches: ['*'] -> ['**']`. That was
 * correct — stacked PRs (this repo's normal working mode) previously ran ZERO
 * `ci.yml` jobs. But `ci.yml` has 19 jobs and carried no `concurrency` group, so
 * stacked PRs went from 0 jobs per push to 19, and every superseded push kept
 * running and kept being billed.
 *
 * ## The two halves, and why BOTH are here
 *
 *   1. `ci.yml` HAS a cancelling concurrency group, keyed so it can only cancel
 *      its own superseded runs.
 *   2. No workflow that publishes, signs, or mutates external state carries
 *      `cancel-in-progress`. Cancelling a half-finished release or cosign
 *      signing run is worse than paying for a duplicate.
 *
 * Half 1 alone would be satisfied by pasting the same block into `release.yml`.
 * Half 2 alone would be satisfied by deleting the group from `ci.yml`. A guard
 * that asserts only one half certifies nothing.
 *
 * ## What was MEASURED about the group key (not reasoned about)
 *
 * `github.ref` differs by construction between the two triggers, taken from the
 * `actions/checkout` fetch refspec in the real logs of two `ci.yml` runs:
 *
 *   - `pull_request` run 31047101359, job 92445178298:
 *     `... origin +66ad79d7...:refs/remotes/pull/668/merge`  -> ref is
 *     `refs/pull/668/merge` (the MERGE commit, not the branch tip);
 *   - `push` run 31047831835, job 92447634366:
 *     `... origin +8c9f5c22...:refs/remotes/origin/main`     -> ref is
 *     `refs/heads/main`.
 *
 * So a bare `group: ci-${{ github.ref }}` would already NOT conflate them: the
 * two events test different refs and cannot collide on that key. `event_name` is
 * in the key anyway so that the separation is a PROPERTY OF THE KEY rather than
 * a property of GitHub's ref naming — if `push:` is ever widened past `[main]`,
 * the guarantee does not have to be re-derived.
 *
 * ## What was checked about mid-run cancellation debris
 *
 * `ci.yml` is the lint/test/e2e workflow. Scanned for the markers below, it
 * carries no publish, no signing, no registry push, no `kubectl apply` and no
 * `gh release` — nothing whose interruption leaves external debris. Its e2e jobs
 * run against ephemeral runner-local state. That is why it is the one workflow
 * this change touches.
 *
 * Two findings from that scan, recorded because "probably not" was not good
 * enough and the first one nearly blocked this change:
 *
 *   - `ci.yml:580` DOES use `docker/build-push-action`, which is why the marker
 *     below is a registry `push: true` rather than the action itself. That step
 *     sets `load: true` and no `push:`, so the image is loaded into the runner's
 *     local docker and never leaves it. The action's NAME is not evidence of a
 *     push; the `push:` input is.
 *   - the same step writes `cache-to: type=gha,mode=max` — shared external state
 *     that outlives the run. Cancelling mid-export is still safe: the buildx GHA
 *     cache is content-addressed and a layer whose export did not finish is
 *     simply not resolvable on the next build, so the failure mode is a cache
 *     MISS, not a poisoned or corrupted entry. No other workflow reads a cache
 *     key `ci.yml` alone produces.
 *
 * ## Relationship to the #667 blocking-gate audit — checked, not assumed
 *
 * `tests/helpers/blocking-gate.ts` rejects JOB-level `concurrency` on an audited
 * gate job, because a cancellable gate is a disarmable gate. Two of those audited
 * gates (`bun-exec-hardcap`, `bun-exec-alpine-image`) live in `ci.yml`, so a
 * WORKFLOW-level group does reach them. The two do not contradict, on one
 * condition, which is now enforced in that helper rather than left as prose: the
 * group must be scoped to the ref, so the ONLY thing that can cancel a gate run
 * is a newer push to the SAME PR — which starts a fresh run whose gates must go
 * green on the new head SHA. A fixed-string group would let one PR cancel
 * another PR's gate, and that is a real disarm; the helper now fails closed on it.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
const CI_YML = 'ci.yml';

/**
 * Markers of a workflow that publishes, signs, or mutates state outside the
 * runner. SCANNED, not enumerated as a list of workflow filenames: a new
 * publishing workflow must be covered without anyone remembering to add it.
 *
 * Deliberately over-broad. A false positive costs a workflow the right to
 * `cancel-in-progress` — the fail-closed direction. A false negative costs a
 * half-finished release.
 */
const EXTERNAL_MUTATION_MARKERS: RegExp[] = [
  /\bnpm publish\b/,
  /\bpnpm publish\b/,
  /changesets\/action/,
  /\bcosign\b/,
  // A registry push, by its INPUT (`docker/build-push-action` with `push: true`)
  // or by the raw command. Matching the action itself would flag `ci.yml`, which
  // uses it with `load: true` to build an image that never leaves the runner.
  /^\s*push:\s*(true|['"]true['"])\s*$/m,
  /\bdocker push\b/,
  /\bgh release create\b/,
  /softprops\/action-gh-release/,
  /\bkubectl apply\b/,
  /\bhelm upgrade\b/,
  /\bpreview\.js deploy\b/,
];

/**
 * Workflows allowed to keep `cancel-in-progress` despite matching a marker.
 * Dated and justified, mirroring the Trivy / npm-audit triage pattern — an
 * exemption that is visible beats a marker set quietly narrowed to hide it.
 *
 * - `preview.yml` (pre-existing, 2026-08): deploys a PR preview to a
 *   PR-SCOPED namespace via `preview.js deploy`, keyed `preview-<pr number>`.
 *   Superseding deploys to one namespace are the intended semantics, and a
 *   cancelled deploy is re-driven to convergence by the run that cancelled it.
 *   It publishes and signs nothing. #674 is explicitly scoped to `ci.yml` and
 *   does not remove this.
 */
const CANCEL_IN_PROGRESS_EXEMPT = new Set(['preview.yml']);

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

/**
 * `text` is the EFFECTIVE workflow — the parsed document re-serialised — not the
 * bytes on disk. Scanning the raw file matches markers inside YAML COMMENTS, and
 * a comment publishes nothing: the sentence "a cancelled release or cosign run
 * is worse than a duplicate", written into `ci.yml` to explain this very rule,
 * classified `ci.yml` as a signing workflow and reddened both halves at once. A
 * round-trip through the parser drops comments and preserves everything the
 * runner will actually execute.
 */
function readWorkflow(file: string): { text: string; doc: Record<string, unknown> } {
  const doc = (parse(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) ?? {}) as Record<
    string,
    unknown
  >;
  return { text: stringify(doc), doc };
}

type Concurrency = { group?: unknown; 'cancel-in-progress'?: unknown } | string | undefined;

/** `cancel-in-progress` is "on" in every form except a literal `false`/absent. */
function cancels(concurrency: Concurrency): boolean {
  if (concurrency === undefined || concurrency === null) return false;
  if (typeof concurrency === 'string') return false; // shorthand: group only
  return 'cancel-in-progress' in concurrency && concurrency['cancel-in-progress'] !== false;
}

/** Workflow-level plus every job-level `concurrency`, so neither is a hiding place. */
function allConcurrencies(
  doc: Record<string, unknown>,
): Array<{ where: string; value: Concurrency }> {
  const found: Array<{ where: string; value: Concurrency }> = [];
  if ('concurrency' in doc)
    found.push({ where: 'workflow-level', value: doc.concurrency as Concurrency });
  const jobs = doc.jobs;
  if (jobs && typeof jobs === 'object') {
    for (const [id, job] of Object.entries(jobs as Record<string, unknown>)) {
      if (job && typeof job === 'object' && 'concurrency' in (job as Record<string, unknown>)) {
        found.push({
          where: `job \`${id}\``,
          value: (job as Record<string, unknown>).concurrency as Concurrency,
        });
      }
    }
  }
  return found;
}

function mutatesExternalState(text: string): RegExp[] {
  return EXTERNAL_MUTATION_MARKERS.filter((m) => m.test(text));
}

describe('ci.yml concurrency group (#674)', () => {
  it('carries a workflow-level concurrency group that cancels superseded runs', () => {
    const { doc } = readWorkflow(CI_YML);
    const concurrency = doc.concurrency as Concurrency;

    expect(concurrency, '`ci.yml` has no workflow-level `concurrency:` block').toBeDefined();
    expect(
      typeof concurrency === 'object' ? concurrency?.group : concurrency,
      '`ci.yml`s concurrency block has no `group:`',
    ).toBeTypeOf('string');
    expect(
      cancels(concurrency),
      '`ci.yml` has a group but does not cancel — superseded stacked-PR pushes keep running all 19 jobs',
    ).toBe(true);
  });

  it('keys the group so it can only cancel its OWN ref, and never across events', () => {
    const { doc } = readWorkflow(CI_YML);
    const group = String((doc.concurrency as { group?: unknown })?.group ?? '');

    // Ref-scoped: this is the condition under which a cancelling workflow-level
    // group cannot disarm the #667-audited gate jobs that live in this file.
    expect(group, `concurrency group \`${group}\` is not scoped to the ref`).toMatch(
      /\$\{\{\s*github\.ref\s*\}\}/,
    );
    // Event-scoped: measured above, `github.ref` alone already separates
    // pull_request (refs/pull/N/merge) from push (refs/heads/main). Keying on
    // the event too makes that separation a property of the key rather than of
    // GitHub's ref naming.
    expect(
      group,
      `concurrency group \`${group}\` does not separate push from pull_request`,
    ).toMatch(/\$\{\{\s*github\.event_name\s*\}\}/);
    // Workflow-scoped: another workflow copying this key must not share a group
    // with CI and start cancelling its runs.
    expect(group, `concurrency group \`${group}\` is not scoped to the workflow`).toMatch(
      /\$\{\{\s*github\.workflow\s*\}\}/,
    );
  });

  it('is itself free of publish/sign/external-mutation markers', () => {
    // The premise of half 1. If `ci.yml` ever grows a publish or signing step,
    // this reds and the group has to be reconsidered, rather than the workflow
    // quietly becoming a cancellable release path.
    const { text } = readWorkflow(CI_YML);
    expect(
      mutatesExternalState(text).map(String),
      '`ci.yml` now mutates external state — a cancelling group is no longer safe here',
    ).toEqual([]);
  });
});

describe('publish/sign workflows never cancel in progress (#674)', () => {
  const scanned = workflowFiles().map((file) => {
    const { text, doc } = readWorkflow(file);
    return { file, markers: mutatesExternalState(text), concurrencies: allConcurrencies(doc) };
  });

  it('non-vacuity: the marker scan actually classifies the known publish path', () => {
    const flagged = scanned.filter((w) => w.markers.length > 0).map((w) => w.file);
    expect(flagged, 'the publish path is not being classified at all').toEqual(
      expect.arrayContaining(['release.yml', 'release-ghp.yml', 'supply-chain.yml']),
    );
  });

  it('no publishing, signing or state-mutating workflow carries cancel-in-progress', () => {
    const violations: string[] = [];
    for (const { file, markers, concurrencies } of scanned) {
      if (markers.length === 0) continue;
      if (CANCEL_IN_PROGRESS_EXEMPT.has(file)) continue;
      for (const { where, value } of concurrencies) {
        if (cancels(value)) {
          violations.push(
            `${file} (${where}) cancels in progress but matches ${markers.map(String).join(', ')} — a cancelled publish/sign/deploy is worse than a duplicate run`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every exemption names a workflow that still exists', () => {
    // An exemption for a deleted file is a hole waiting for a filename to be
    // reused, and it hides the fact that nobody re-justified it.
    const present = new Set(workflowFiles());
    for (const file of CANCEL_IN_PROGRESS_EXEMPT) {
      expect(
        present.has(file),
        `exempt workflow ${file} no longer exists — drop the exemption`,
      ).toBe(true);
    }
  });
});
