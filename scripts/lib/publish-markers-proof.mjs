/**
 * The mutation list for `scripts/mutation-prove-publish-markers.mjs`.
 *
 * Split out (#681 item 4) so `tests/publish-markers-proof-runnable.test.ts` can
 * assert every anchor still resolves WITHOUT running the mutations — importing
 * the script would run all of them, which is minutes of vitest. Nothing here
 * executes anything on import; this file is data.
 *
 * Why it needed splitting: the item-5 anchor named `const REF_SCOPED = /.../`,
 * a construct #675 had deleted. `mutate()` aborts on an anchor it cannot find
 * exactly once, so the run died there and items 6-10 NEVER EXECUTED while the
 * proof was still cited as evidence. A text anchor is a deletable string and
 * nothing makes it immune to that; what the split buys is that the breakage is
 * LOUD — it reds under vitest, which runs on every PR — instead of waiting for
 * someone to run the prover by hand. No CI job runs any prover
 * (`grep -rn mutation-prove .github/workflows/` is empty), so that test is the
 * only thing between a stale anchor and a proof that silently covers less than
 * it claims.
 *
 * Paths are REPO-RELATIVE so both consumers resolve them against the same root.
 */

const MARKERS = 'tests/helpers/publish-markers.ts';
const GATE_HELPER = 'tests/helpers/blocking-gate.ts';
const CI_YML = '.github/workflows/ci.yml';

export const CONCURRENCY_SPEC = 'tests/ci-concurrency-group.test.ts';
export const GATE_SPEC = 'tests/blocking-gate-helper.test.ts';

/** Each entry restores one pre-fix behaviour; the spec must go RED for it. */
export const MUTATIONS = [
  // Item 1: the registry-push marker matched only a LITERAL `true`, so the
  // idiomatic `push: ${{ ... }}` classified as non-publishing.
  {
    label: 'item 1 — build-push-action `push:` accepts only a literal true again',
    file: MARKERS,
    spec: CONCURRENCY_SPEC,
    anchor: "      if (push === false || push === 'false') return;",
    replacement: "      if (push !== true && push !== 'true') return;",
  },
  // Item 2: `stringify(doc)` folds at column 80, splitting two-word markers.
  {
    label: 'item 2 — re-serialise at the default lineWidth of 80 again',
    file: MARKERS,
    spec: CONCURRENCY_SPEC,
    anchor: '  const text = stringify(doc, { lineWidth: 0 });',
    replacement: '  const text = stringify(doc);',
  },
  // Item 3: `crane push`/`crane copy` — this repo's actual publish command —
  // was absent from the marker set.
  {
    label: "item 3 — drop the `crane` marker (the repo's own publish command)",
    file: MARKERS,
    spec: CONCURRENCY_SPEC,
    anchor: "  { id: 'crane push', re: /\\bcrane (push|copy)\\b/ },",
    replacement: '',
  },
  // Item 4: cancellation must not reach the push->main group.
  {
    label: 'item 4 — widen cancel-in-progress back to every event',
    file: CI_YML,
    spec: CONCURRENCY_SPEC,
    anchor: "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    replacement: '  cancel-in-progress: true',
  },
  // Item 5: the round-1 group check accepted any interpolation merely
  // CONTAINING `github.ref`.
  //
  // RETARGETED (#679) onto `bodyIsPerPr`'s body, because the anchor it used to
  // carry stopped existing — see the header. Restoring the round-1 SUBSTRING
  // behaviour is still the right mutation; it just has to be expressed against
  // the construct that exists now.
  {
    label: 'item 5 — the group check accepts a substring match again',
    file: GATE_HELPER,
    spec: GATE_SPEC,
    anchor:
      '  const admissible = operands.every((o) => PER_PR_OPERAND.has(o) || DISPATCH_INPUT.test(o));\n  return admissible && operands.some((o) => PER_PR_OPERAND.has(o));',
    replacement: '  return /github\\.(ref|ref_name|head_ref)/.test(body);',
  },
  // Item 6: the exemption is per-marker, not per-file.
  {
    label: 'item 6 — make the cancel-in-progress exemption blanket per file again',
    file: CONCURRENCY_SPEC,
    spec: CONCURRENCY_SPEC,
    anchor: '  return markers.filter((m) => !excused.has(m));',
    replacement: '  return excused.size > 0 ? [] : markers;',
  },
  // Item 7 (#679): a typo in a marker's NON-FIRST alternation branch. This is
  // the exact invisibility #675's per-marker samples removed at marker
  // granularity and left open one level down — `crane copy` matched no sample,
  // so `copy` could be misspelled without any test noticing.
  {
    label: 'item 7 — misspell the `copy` branch of the crane marker',
    file: MARKERS,
    spec: CONCURRENCY_SPEC,
    anchor: "  { id: 'crane push', re: /\\bcrane (push|copy)\\b/ },",
    replacement: "  { id: 'crane push', re: /\\bcrane (push|kopy)\\b/ },",
  },
  // Item 8 (#679): the same for `gh release`, whose `upload` and `edit`
  // branches were likewise unexercised.
  {
    label: 'item 8 — misspell the `edit` branch of the gh-release marker',
    file: MARKERS,
    spec: CONCURRENCY_SPEC,
    anchor: "  { id: 'gh release', re: /\\bgh release (create|upload|edit)\\b/ },",
    replacement: "  { id: 'gh release', re: /\\bgh release (create|upload|edti)\\b/ },",
  },
  // Item 9 (#679): the branch-coverage assertion itself. Deleting a branch
  // sample must red rather than silently shrink what is exercised.
  {
    label: 'item 9 — delete the `crane copy` branch sample',
    file: CONCURRENCY_SPEC,
    spec: CONCURRENCY_SPEC,
    anchor:
      "    'jobs:\\n  p:\\n    steps:\\n      - run: crane copy ghcr.io/org/app:1.0.0 ghcr.io/org/app:stable\\n',",
    replacement: '',
  },
  // Item 10 (#679): the mutation ONLY the branch-coverage assertion catches,
  // and the reason items 7-9 are not the whole story.
  //
  // MEASURED: the two typo mutations above also red the pre-existing "covers
  // THIS repo's registry-publish commands" test, which lists those commands by
  // hand — so `crane copy` and `gh release upload|edit` were already exercised,
  // just not by anything that ASSERTS coverage. That list is an enumeration,
  // and this is how the next branch gets missed: adding one to an existing
  // marker leaves it unexercised and reds nothing. Under the branch-level
  // assertion it reds immediately.
  {
    label: 'item 10 — add an unexercised alternation branch to an existing marker',
    file: MARKERS,
    spec: CONCURRENCY_SPEC,
    anchor: "  { id: 'crane push', re: /\\bcrane (push|copy)\\b/ },",
    replacement: "  { id: 'crane push', re: /\\bcrane (push|copy|mutate)\\b/ },",
  },
  // Item 11 (#681 item 3): the mutation that reds the one-to-one assertion
  // ALONE, which is what earns it a place.
  //
  // Its first version asserted only "every sample matches some branch", and
  // that is ENTAILED by the per-marker test: branch regexes are the marker
  // narrowed one alternative at a time, so their union IS the marker. Measured
  // — inserting a NON-matching sample reddened both, so it could never red on
  // its own, and a guard that cannot fail alone is decoration by this repo's
  // rule. A DUPLICATE sample is the case it now owns: it matches a branch,
  // leaves every branch covered, and exercises nothing new.
  {
    label: 'item 11 — pad a marker with a duplicate sample that exercises no new branch',
    file: CONCURRENCY_SPEC,
    spec: CONCURRENCY_SPEC,
    anchor:
      "    'jobs:\\n  p:\\n    steps:\\n      - run: crane push image-oci ghcr.io/org/app:1.0.0\\n',",
    replacement:
      "    'jobs:\\n  p:\\n    steps:\\n      - run: crane push image-oci ghcr.io/org/app:1.0.0\\n',\n    'jobs:\\n  p:\\n    steps:\\n      - run: crane push other-oci ghcr.io/org/app:2.0.0\\n',",
  },
  // Item 12 (#681 item 2): the branch enumerator failed OPEN on an UNGROUPED
  // top-level alternation — `/\bfoo\b|\bbar\b/` yielded one "branch" equal to
  // the whole source, so one sample satisfied the coverage assertion and the
  // other alternative went unexercised, silently. That is the invisibility the
  // enumerator exists to remove, reintroduced by the natural way the next
  // marker gets written.
  {
    label: 'item 12 — the branch enumerator fails OPEN on an ungrouped alternation again',
    file: MARKERS,
    spec: CONCURRENCY_SPEC,
    anchor: "  if (`${before}${after}`.includes('|')) {",
    replacement: '  if (false) {',
  },
  // Item 13 (#681 item 1): the `head_ref` tripwire. The fork-PR decision in
  // `tests/helpers/blocking-gate.ts` — accept `github.head_ref` as per-PR
  // scoping — was recorded on the premise that no group in this repo rests on
  // it. Round 1 stated that premise as prose and propped it up with a claim
  // that was FALSE (that `preview.yml:47` uses the `head_ref || …` idiom; it
  // does not, and `head_ref` appears in no workflow here). Prose cannot notice
  // when its premise stops holding, so the premise is a test now — and this
  // mutation is what shows the test is not decoration: introducing exactly the
  // group the decision assumed does not exist must red.
  //
  // `preview.yml` deliberately, not `ci.yml`: no other assertion pins
  // `preview.yml`'s group text, so the failure is ATTRIBUTABLE to the tripwire.
  {
    label: 'item 13 — scope a real workflow concurrency group on `github.head_ref`',
    file: '.github/workflows/preview.yml',
    spec: CONCURRENCY_SPEC,
    anchor: '  group: preview-${{ github.event.pull_request.number || github.event.inputs.pr }}',
    replacement: '  group: preview-${{ github.head_ref || github.event.inputs.pr }}',
  },
];
