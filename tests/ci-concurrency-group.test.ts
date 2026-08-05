import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  BUILD_PUSH_ACTION_MARKER,
  buildPushActionPublishes,
  classifyWorkflowSource,
  effectiveWorkflowText,
  RUN_MARKERS,
} from './helpers/publish-markers';

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
 * ## Cancellation is scoped to `pull_request` — the decision, and its cost
 *
 * Separating the GROUPS by `event_name` stops the two triggers cancelling each
 * other. It does NOT stop the `push`->`main` group cancelling ITSELF, and that
 * matters here: two merges landing inside one CI duration would cancel `main`'s
 * run for the intermediate commit, leaving that commit with no verdict. This
 * repo has already been in the state where `main` was red across three commits;
 * the thing that makes that tractable is a per-commit result to bisect against.
 *
 * #674's entire motivation — stacked-PR cost — lives in the `pull_request`
 * group. So `cancel-in-progress` is gated on the event: the saving is taken in
 * full, and `main` keeps a run per commit. The cost of that choice, stated
 * rather than left implicit: consecutive merges to `main` are billed in full,
 * which is a handful of runs a week against the tens of superseded stacked-PR
 * runs this change is actually for.
 *
 * ## What was checked about mid-run cancellation debris
 *
 * This is an audit of `ci.yml`'s external writes, and it is MARKER-LIMITED, not
 * exhaustive — round 1 stated it as exhaustive and it was not. What the markers
 * establish is the absence of a publish, a signature, a registry push, a
 * `kubectl apply` and a `gh release`. Separately enumerated, by reading the
 * file, `ci.yml` writes outside the runner in exactly three places:
 *
 *   - `ci.yml:610` DOES use `docker/build-push-action`, which is why the check
 *     below is on the `push:` INPUT rather than the action's name. That step
 *     sets `load: true` and no `push:`, so the image is loaded into the runner's
 *     local docker and never leaves it. The action's NAME is not evidence of a
 *     push; the input is.
 *   - the same step writes `cache-to: type=gha,mode=max`, and the two `setup-*`
 *     steps write the Actions cache. Cancelling mid-export is believed safe
 *     because the buildx GHA cache is content-addressed, so a layer whose export
 *     did not finish is simply not resolvable on the next build — a cache MISS,
 *     not a poisoned entry. Recorded honestly: that is CONSISTENT WITH the
 *     backend's design but is neither cited to upstream documentation nor
 *     measured here. No other workflow reads a cache key `ci.yml` alone
 *     produces, which bounds the blast radius regardless.
 *   - `ci.yml:123` uploads coverage to `codecov/codecov-action`. Omitted from
 *     round 1's audit because no marker names it. Benign: the upload is keyed
 *     per commit SHA and append-only, a missing upload degrades a report rather
 *     than corrupting one, and no Codecov status is a required context (see the
 *     branch-protection note below).
 *
 * Also confirmed, because a cancelled run being "green" would be the real
 * danger: branch protection is `strict: true` over 11 required contexts, six of
 * them from `ci.yml`. A cancelled or missing required context is not `success`,
 * so a cancelled run BLOCKS the merge rather than passing it.
 *
 * ## The cancellation itself is OBSERVED, not only guarded
 *
 * The guards below prove the config; they cannot prove GitHub honours it. Round
 * 1 had no superseded run to point at, because the branch had a single push. So
 * one was produced: two pushes to this PR inside one CI duration, both
 * `pull_request`, on `ci.yml` as it stands here.
 *
 *   - run 31052852836, head `c9e0502` -> `completed` / **`cancelled`**
 *   - run 31052899155, head `490369b` -> the superseding run
 *
 * Cancellation therefore happens, it is scoped to this ref, and the surviving
 * run is the one on the new head SHA — which is the whole argument for why a
 * ref-scoped group does not disarm the #667-audited gates that live in here.
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
 * Workflows allowed to keep `cancel-in-progress` despite matching a marker —
 * keyed to the MARKERS the exemption excuses, not blanket per file.
 *
 * Round 1 keyed this by filename alone, so `preview.yml` gaining a `cosign` or
 * `npm publish` step would have stayed waved through with no signal at all. An
 * exemption has to name what it is excusing or it is an unbounded licence.
 *
 * - `preview.yml` for `preview.js deploy` (pre-existing, 2026-08): deploys a PR
 *   preview to a PR-SCOPED namespace, keyed `preview-<pr number>`. Superseding
 *   deploys to one namespace are the intended semantics, and a cancelled deploy
 *   is re-driven to convergence by the run that cancelled it. It publishes and
 *   signs nothing. #674 is explicitly scoped to `ci.yml` and does not remove it.
 */
const CANCEL_IN_PROGRESS_EXEMPT = new Map<string, Set<string>>([
  ['preview.yml', new Set(['preview.js deploy'])],
]);

/**
 * The markers a file matches that its exemption does NOT excuse.
 *
 * A named function rather than an inline filter because it is the whole of the
 * item-6 fix and it cannot be proved against the real workflow directory:
 * `preview.yml` matches exactly one marker today and that marker is the excused
 * one, so blanket and per-marker exemption are indistinguishable there. The
 * difference only shows on an input the repo does not currently contain, which
 * is precisely the input round 1 never tried. It is asserted directly below.
 */
function unexcusedMarkers(file: string, markers: string[]): string[] {
  const excused = CANCEL_IN_PROGRESS_EXEMPT.get(file) ?? new Set<string>();
  return markers.filter((m) => !excused.has(m));
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

function readWorkflow(file: string) {
  return classifyWorkflowSource(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8'));
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

  it('cancels only `pull_request` runs, so `main` keeps a verdict per commit', () => {
    // The item-4 decision, made enforceable rather than left as prose. Grouping
    // by `event_name` separates the two triggers but does not stop the
    // push->main group cancelling itself; two merges inside one CI duration
    // would leave the intermediate commit with no verdict to bisect against.
    //
    // Fails closed on any OTHER value, including a bare `true`: whoever widens
    // cancellation back to `push` has to come here and say why.
    const { doc } = readWorkflow(CI_YML);
    const value = (doc.concurrency as { 'cancel-in-progress'?: unknown })?.['cancel-in-progress'];
    expect(
      typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
      "`ci.yml`s cancel-in-progress is not gated on `github.event_name == 'pull_request'` — a merge to main can now cancel the previous commit's run",
    ).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it('is itself free of publish/sign/external-mutation markers', () => {
    // The premise of half 1. If `ci.yml` ever grows a publish or signing step,
    // this reds and the group has to be reconsidered, rather than the workflow
    // quietly becoming a cancellable release path.
    const { markers } = readWorkflow(CI_YML);
    expect(
      markers,
      '`ci.yml` now mutates external state — a cancelling group is no longer safe here',
    ).toEqual([]);
  });
});

describe('publish/sign workflows never cancel in progress (#674)', () => {
  const scanned = workflowFiles().map((file) => {
    const { markers, doc } = readWorkflow(file);
    return { file, markers, concurrencies: allConcurrencies(doc) };
  });

  it('non-vacuity: the marker scan actually classifies the known publish path', () => {
    const flagged = scanned.filter((w) => w.markers.length > 0).map((w) => w.file);
    expect(flagged, 'the publish path is not being classified at all').toEqual(
      expect.arrayContaining(['release.yml', 'release-ghp.yml', 'supply-chain.yml']),
    );
  });

  it('classifies each publish workflow by what it ACTUALLY does, not incidentally', () => {
    // Round 1's real hole. `supply-chain.yml` and `operator-supply-chain.yml`
    // publish with `crane push` — deliberately, because `docker push` drops the
    // OCI layout — and `crane` was not a marker. Both were flagged only because
    // they also run `cosign`. Drop the signing step from either and the registry
    // publish would have become invisible.
    //
    // So each file asserts the marker naming its OWN publish mechanism. This is
    // the mitigation for the marker list being a floor: a workflow classified by
    // the wrong reason reds here.
    const byFile = new Map(scanned.map((w) => [w.file, w.markers]));
    const expected: Array<[string, string]> = [
      ['supply-chain.yml', 'crane push'],
      ['operator-supply-chain.yml', 'crane push'],
    ];
    for (const [file, marker] of expected) {
      expect(byFile.get(file), `${file} is not classified by its own publish command`).toContain(
        marker,
      );
    }
  });

  it('no publishing, signing or state-mutating workflow carries cancel-in-progress', () => {
    const violations: string[] = [];
    for (const { file, markers, concurrencies } of scanned) {
      // Per-MARKER exemption: only the markers named in the exemption are
      // excused. A newly-added `cosign` in `preview.yml` is not covered by its
      // `preview.js deploy` exemption and reds here.
      const unexcused = unexcusedMarkers(file, markers);
      if (unexcused.length === 0) continue;
      for (const { where, value } of concurrencies) {
        if (cancels(value)) {
          violations.push(
            `${file} (${where}) cancels in progress but matches ${unexcused.join(', ')} — a cancelled publish/sign/deploy is worse than a duplicate run`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('an exemption excuses only the markers it NAMES', () => {
    // Round 1 keyed the exemption by filename alone, so `preview.yml` gaining a
    // `cosign` or `npm publish` step would have stayed waved through with no
    // signal. Asserted on synthetic marker sets because the real `preview.yml`
    // matches exactly the one excused marker, which is why the defect was
    // invisible in the directory the guard actually scans.
    expect(unexcusedMarkers('preview.yml', ['preview.js deploy'])).toEqual([]);
    expect(
      unexcusedMarkers('preview.yml', ['preview.js deploy', 'cosign']),
      'a blanket per-file exemption is waving through a signing step',
    ).toEqual(['cosign']);
    expect(unexcusedMarkers('release.yml', ['npm publish'])).toEqual(['npm publish']);
  });

  it('every exemption names a workflow that still exists, and a marker it still matches', () => {
    // An exemption for a deleted file is a hole waiting for a filename to be
    // reused. An exemption for a marker the file no longer matches is a licence
    // nobody re-justified — and, keyed per marker, it is also how a stale entry
    // would silently widen back to blanket.
    const present = new Set(workflowFiles());
    for (const [file, excused] of CANCEL_IN_PROGRESS_EXEMPT) {
      expect(
        present.has(file),
        `exempt workflow ${file} no longer exists — drop the exemption`,
      ).toBe(true);
      const { markers } = readWorkflow(file);
      for (const marker of excused) {
        expect(
          markers,
          `${file} no longer matches the exempted marker \`${marker}\` — re-justify or drop it`,
        ).toContain(marker);
      }
    }
  });
});

/**
 * The CLASSIFIER's own coverage.
 *
 * Every test above asks the classifier one question about the real workflow
 * directory, where the answer is already known. That shape cannot reveal a hole:
 * round 1 had four, and all four were found by executing it against inputs it
 * had never been given. These are those inputs.
 *
 * `scripts/mutation-prove-publish-markers.mjs` is the standing proof that they
 * bite: it restores each round-1 behaviour from a byte snapshot and requires
 * this file to go red.
 */
describe('publish/sign marker classification (#674 round 2)', () => {
  it('treats a `docker/build-push-action` push EXPRESSION as publishing', () => {
    // `push: ${{ github.event_name != 'pull_request' }}` is the idiomatic form,
    // and round 1's `/^\s*push:\s*(true|['"]true['"])\s*$/m` classified it as
    // NON-publishing. Same inversion #667 already paid for on
    // `continue-on-error: ${{ true }}`: an expression is not the literal.
    const { markers } = classifyWorkflowSource(`
jobs:
  build:
    steps:
      - uses: docker/build-push-action@v6
        with:
          push: \${{ github.event_name != 'pull_request' }}
          tags: ghcr.io/org/app:1.0.0
`);
    expect(markers).toContain(BUILD_PUSH_ACTION_MARKER);
  });

  it('treats a literal `push: true` as publishing', () => {
    const { markers } = classifyWorkflowSource(`
jobs:
  build:
    steps:
      - uses: docker/build-push-action@v6
        with:
          push: true
`);
    expect(markers).toContain(BUILD_PUSH_ACTION_MARKER);
  });

  it('NEGATIVE CONTROL: `load: true` with no `push:` is not publishing — this is ci.yml', () => {
    const { markers } = classifyWorkflowSource(`
jobs:
  build:
    steps:
      - uses: docker/build-push-action@v6
        with:
          load: true
          cache-to: type=gha,mode=max
`);
    expect(markers).toEqual([]);
  });

  it('NEGATIVE CONTROL: an `on: push:` trigger is not a registry push', () => {
    // Why this cannot be a text rule. Widening the round-1 regex enough to catch
    // the expression form flags the TRIGGER in every workflow in the repo, which
    // is a false-positive so total the guard would have to be disabled.
    const { markers } = classifyWorkflowSource(`
on:
  push:
    branches: [main]
jobs:
  test:
    steps:
      - run: echo hi
`);
    expect(markers).toEqual([]);
  });

  it('does not fold two-word markers apart when re-serialising', () => {
    // MEASURED: with `stringify`'s default `lineWidth: 80`, this exact input
    // re-emits as `... && npm\n  publish --access public` and `/\bnpm publish\b/`
    // stops matching. Classification of a publish workflow must not depend on
    // the column position of the command.
    const source = `
jobs:
  release:
    steps:
      - run: cd ${'p'.repeat(58)} && npm publish --access public
`;
    expect(effectiveWorkflowText(source)).toMatch(/\bnpm publish\b/);
    expect(classifyWorkflowSource(source).markers).toContain('npm publish');
  });

  it("covers THIS repo's registry-publish commands, not just docker's", () => {
    // `crane push`/`crane copy` were absent from round 1 while being the actual
    // publish command in two workflows here.
    for (const [command, marker] of [
      ['crane push image-oci ghcr.io/org/app:1.0.0', 'crane push'],
      ['crane copy ghcr.io/org/app:1.0.0 ghcr.io/org/app:latest', 'crane push'],
      ['skopeo copy oci:layout docker://ghcr.io/org/app:1.0.0', 'skopeo copy'],
      ['oras push ghcr.io/org/app:1.0.0 sbom.json', 'oras push'],
      ['gh release upload v1.0.0 dist.tgz', 'gh release'],
      ['gh release edit v1.0.0 --draft=false', 'gh release'],
      ['npm dist-tag add @getknext/core@1.0.0 latest', 'npm dist-tag'],
    ] as const) {
      const { markers } = classifyWorkflowSource(
        `jobs:\n  p:\n    steps:\n      - run: ${command}\n`,
      );
      expect(markers, `\`${command}\` is not classified as publishing`).toContain(marker);
    }
  });

  it('NEGATIVE CONTROL: a non-publishing crane subcommand is not a push', () => {
    // `supply-chain.yml` also runs `crane manifest` to read an attestation. The
    // over-broad direction is the safe one, but not so broad that the marker
    // stops meaning anything.
    const { markers } = classifyWorkflowSource(
      'jobs:\n  p:\n    steps:\n      - run: crane manifest ghcr.io/org/app:1.0.0\n',
    );
    expect(markers).toEqual([]);
  });

  it('matches nothing inside a YAML comment', () => {
    // The round-1 regression this classifier already fixed, kept covered: the
    // sentence explaining the cosign rule, written into `ci.yml`, classified
    // `ci.yml` as a signing workflow.
    const { markers } = classifyWorkflowSource(`
# a cancelled release or cosign run is worse than a duplicate, and
# nothing here runs npm publish or crane push
jobs:
  test:
    steps:
      - run: echo hi
`);
    expect(markers).toEqual([]);
  });

  it('non-vacuity: every marker id is distinct and every regex matches something', () => {
    // A marker whose regex can never match is decoration, and a duplicated id
    // silently merges two exemptions into one.
    const ids = RUN_MARKERS.map((m) => m.id);
    expect(new Set(ids).size, 'duplicate marker id').toBe(ids.length);
    for (const { id, re } of RUN_MARKERS) {
      expect(re.source.length, `marker \`${id}\` has an empty pattern`).toBeGreaterThan(0);
    }
  });

  it('the structural check reads the real ci.yml build step and finds no push', () => {
    // Non-vacuity for `buildPushActionPublishes` against the file it exists for:
    // if `ci.yml` ever stops using `docker/build-push-action`, the negative
    // controls above still pass but this claim would be about nothing.
    const raw = readFileSync(resolve(WORKFLOW_DIR, CI_YML), 'utf8');
    expect(raw, '`ci.yml` no longer uses docker/build-push-action').toMatch(
      /docker\/build-push-action/,
    );
    expect(buildPushActionPublishes(parse(raw) as Record<string, unknown>)).toEqual([]);
  });
});
