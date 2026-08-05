import { readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

/**
 * "Does this workflow publish, sign, or mutate state outside the runner?" (#674).
 *
 * Extracted from `tests/ci-concurrency-group.test.ts` so it can be exercised
 * against synthetic workflows. The round-1 version was only ever run over the
 * real `.github/workflows`, which is blind by construction: a classifier that is
 * asked one question with one known answer cannot be shown to have holes. Round 2
 * found four by executing it against inputs it had never seen.
 */

/**
 * The parsed document, re-serialised — NOT the bytes on disk.
 *
 * Two things this fixes, both measured:
 *
 *   1. Scanning raw bytes matches markers inside YAML COMMENTS, and a comment
 *      publishes nothing: the sentence "a cancelled release or cosign run is
 *      worse than a duplicate", written into `ci.yml` to explain this very rule,
 *      classified `ci.yml` as a signing workflow.
 *   2. `lineWidth: 0` is load-bearing, not cosmetic. `stringify` defaults to
 *      folding at column 80, and it folds INSIDE a `run:` command: measured, a
 *      `run:` of `cd <58 chars> && npm publish --access public` re-emits as
 *      `... && npm\n  publish --access public`, after which `/\bnpm publish\b/`
 *      does not match. Classification would otherwise depend on the COLUMN
 *      POSITION of the command — the two-word markers (`npm publish`,
 *      `docker push`, `crane push`, `kubectl apply`, `gh release create`,
 *      `helm upgrade`) are all splittable this way. Nothing is misclassified
 *      today only because this repo's sole matching marker in a long line is the
 *      single word `cosign`, which cannot be split.
 */
export function effectiveWorkflowText(raw: string): string {
  return stringify(parse(raw) ?? {}, { lineWidth: 0 });
}

/**
 * Text markers of publishing / signing / external mutation.
 *
 * ## This is a LIST, and the list is a FLOOR, not coverage
 *
 * Round 1 claimed "scanned, not enumerated: a new publishing workflow is covered
 * without anyone remembering to add it". That claim was false in the direction
 * that matters, and the proof was in this repo: the actual registry-publish
 * command here is `crane push` (`supply-chain.yml:181`,
 * `operator-supply-chain.yml:208`, chosen deliberately over `docker push`
 * because the daemon store drops the OCI layout) and it was **not in the list**.
 * Both files were classified only INCIDENTALLY, via the word `cosign`.
 *
 * So: can this be a scan rather than a list? For the `run:` half, **no**, and it
 * is worth saying why rather than implying otherwise. A `run:` body is an
 * arbitrary shell string; "publishes to something outside this runner" is an
 * open vocabulary over every CLI that exists, and there is no parseable
 * construct that distinguishes `crane push` from `crane manifest`. Any check
 * over that surface is an enumeration wearing different clothes.
 *
 * What CAN be scanned is the structured half, and that half is scanned:
 * `buildPushActionPublishes` below reads the `with.push` INPUT of every
 * `docker/build-push-action` step from the parsed document, and fails closed on
 * everything except a literal `false`.
 *
 * The mitigations for the list's incompleteness, in place of a false coverage
 * claim: it is deliberately over-broad (a false positive only costs a workflow
 * the right to `cancel-in-progress`), and `ci-concurrency-group.test.ts` carries
 * a non-vacuity test asserting each known publish workflow is classified by a
 * marker naming what it ACTUALLY does — so "classified incidentally by cosign"
 * cannot recur silently.
 */
export const RUN_MARKERS: Array<{ id: string; re: RegExp }> = [
  { id: 'npm publish', re: /\bnpm publish\b/ },
  { id: 'pnpm publish', re: /\bpnpm publish\b/ },
  { id: 'npm dist-tag', re: /\bnpm dist-tag\b/ },
  { id: 'changesets/action', re: /changesets\/action/ },
  { id: 'cosign', re: /\bcosign\b/ },
  { id: 'docker push', re: /\bdocker push\b/ },
  // THIS repo's registry-publish command. Absent from round 1's list, which is
  // why the claim above is now a floor rather than coverage.
  { id: 'crane push', re: /\bcrane (push|copy)\b/ },
  { id: 'skopeo copy', re: /\bskopeo copy\b/ },
  { id: 'oras push', re: /\boras push\b/ },
  { id: 'gh release', re: /\bgh release (create|upload|edit)\b/ },
  { id: 'softprops/action-gh-release', re: /softprops\/action-gh-release/ },
  { id: 'kubectl apply', re: /\bkubectl apply\b/ },
  { id: 'helm upgrade', re: /\bhelm upgrade\b/ },
  { id: 'preview.js deploy', re: /\bpreview\.js deploy\b/ },
];

/** The one marker id produced structurally rather than by a text match. */
export const BUILD_PUSH_ACTION_MARKER = 'docker/build-push-action push:';

function isStepList(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value);
}

/**
 * Does any `docker/build-push-action` step push to a registry?
 *
 * Read from the PARSED document by input, not by regex over text, and FAIL
 * CLOSED: anything except an absent `push:` or a literal `false` counts as a
 * push. Round 1 asked this with `/^\s*push:\s*(true|['"]true['"])\s*$/m`, which
 * matches only the literal — so the idiomatic
 * `push: ${{ github.event_name != 'pull_request' }}` classified as
 * NON-publishing. That is the exact inversion #667 already paid for
 * (`continue-on-error: ${{ true }}`) and that this same PR gets right two files
 * over: an expression is not the literal.
 *
 * Absent `push:` is the safe default because the action's own default is
 * `false`; `ci.yml:610` relies on it, building with `load: true` so the image
 * never leaves the runner.
 *
 * A regex cannot do this job at all, in either direction: `push:` is also the
 * name of a workflow TRIGGER (`on: push:`), so a text rule broad enough to catch
 * the expression form flags every workflow in the repo.
 */
export function buildPushActionPublishes(doc: Record<string, unknown>): string[] {
  const found: string[] = [];
  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== 'object') return found;
  for (const [jobId, job] of Object.entries(jobs as Record<string, unknown>)) {
    if (!job || typeof job !== 'object') continue;
    const steps = (job as Record<string, unknown>).steps;
    if (!isStepList(steps)) continue;
    steps.forEach((step, i) => {
      if (!step || typeof step !== 'object') return;
      const uses = step.uses;
      if (typeof uses !== 'string' || !/docker\/build-push-action/.test(uses)) return;
      const withInputs = step.with;
      if (!withInputs || typeof withInputs !== 'object') return;
      const push = (withInputs as Record<string, unknown>).push;
      if (push === undefined) return;
      if (push === false || push === 'false') return;
      const name = typeof step.name === 'string' ? step.name : `#${i + 1}`;
      found.push(`job \`${jobId}\` step \`${name}\` (push: ${JSON.stringify(push)})`);
    });
  }
  return found;
}

export interface WorkflowClassification {
  /** Stable marker ids, sorted. Empty means "mutates nothing outside the runner". */
  markers: string[];
  /** The re-serialised document the text markers were matched against. */
  text: string;
  doc: Record<string, unknown>;
}

export function classifyWorkflowSource(raw: string): WorkflowClassification {
  const doc = (parse(raw) ?? {}) as Record<string, unknown>;
  const text = stringify(doc, { lineWidth: 0 });
  const markers = RUN_MARKERS.filter((m) => m.re.test(text)).map((m) => m.id);
  if (buildPushActionPublishes(doc).length > 0) markers.push(BUILD_PUSH_ACTION_MARKER);
  return { markers: markers.sort(), text, doc };
}

export function classifyWorkflowFile(path: string): WorkflowClassification {
  return classifyWorkflowSource(readFileSync(path, 'utf8'));
}
