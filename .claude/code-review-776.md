# Code review — PR #776 (docs(adr-0037): price the unpinned window)

**Verdict: ISSUES_FOUND** — all findings are documentation-accuracy/internal-consistency in the
added paragraph. Nothing in it is code-wrong, and no rule (security.md / architecture.md) is
crossed; it is a docs-only ADR amendment transcribing the #767 gate ruling.

## What checks out (verified against the tree, not the PR body)

- **14.9 s exists in the cited record.** `docs/benchmarks/fm-confirmatory-prepulled-ab-2026-08-18.md:165-166`
  — "the sampling sitting's 14.9 s first-pull sample is a reminder the prepull pins track digests:
  they pin what they are told, not what is deployed." Citation is to the right file.
- **~7× is arithmetically defensible, like-for-like.** The sample belongs to the Addendum-4 sitting,
  whose confirmed-zero cold median is ~2.23 s (line 155) — 14.9/2.23 = 6.7×; against the scoreboard
  rows 2140/2280 ms it is 7.0/6.5×. (Against that record's *node* arm median 3685 ms it is only 4.0×,
  so the ratio implicitly picks the fastest arm — acceptable, but that is the ceiling of the range.)
- **`image_prewarm.go` really does CreateOrUpdate over `app.Spec.Image`.** `image_prewarm.go:221-230`
  reassigns `ds.Spec.Template` from `buildImagePrewarmDaemonSet` inside the mutate fn, and that
  template's main container is `Image: app.Spec.Image` (`:177`). Re-points on **every** reconcile, as
  claimed.
- **The quoted envtest name exists verbatim** — `image_prewarm_envtest_test.go:100`, and it is not a
  tautology: it reconciles, flips `Spec.Image` to `image2`, reconciles again, asserts the DaemonSet
  container image equals `image2` (`:127`).
- **The hand-rolled corollary does not invalidate the ADR's own evidence.** `image-prewarm-oke.md`
  selects arms **through the CR** (`:84-85`, `spec.scaling.imagePrewarm`), so the 0/10-vs-10/10 proof
  is untouched by "do not cite hand-rolled DaemonSets".
- **Markdown renders correctly.** The paragraph is indented 2 spaces after a blank line inside the
  `- **Interaction with revisions/rollout:**` item, i.e. a continuation paragraph of that bullet —
  same nesting as the sibling sub-bullets in this file. Bold spanning a soft line break is fine.

## Issues

1. `docs/adr/0037-image-caching-prepull.md:99-100` — "**not the ~2 s the cost model assumed**"
   contradicts what this same ADR already records two sections down. Line 279-283 states, of the same
   ~2 s estimate: "holds at the median and understates the tail … p75 to p75 is +3.9 s and **max to
   max +10.7 s**", and `image-prewarm-oke.md:142` records an `imagePrewarm=false` **max of 13812 ms**.
   So a ~14 s unpinned request was already inside this ADR's evidence base; the new paragraph presents
   it as overturning an assumption the ADR had itself already qualified. **Why it matters:** the ADR is
   the durable record — a reader who reaches line 280 after line 99 gets two different characterisations
   of "what the cost model assumed" and cannot tell which is current. One clause cross-referencing the
   existing tail line ("consistent with the +10.7 s max-to-max tail recorded below") fixes it and makes
   the finding *stronger*, not weaker: it is corroboration, not a surprise.

2. `docs/adr/0037-image-caching-prepull.md:99-102` — total-vs-increment mismatch. 14.9 s is a whole
   first-byte time (cold start **plus** pull); the "~2 s" is only the **pull component** (line 13:
   "pulls in ~2.09 s"). This ADR's own model predicts **~4.2 s** for a cold-image cold start (line 15),
   which is the number 14.9 s should be compared against; the incremental unpinned cost is ~12.7 s, not
   14.9 s. **Why it matters:** as written the sentence overstates the gap by comparing a total to a
   component, in a repo whose review rules single out exactly this class of measurement framing.
   State it as "14.9 s end-to-end vs the ~4.2 s cold-image cold start the model predicts (≈ +12.7 s of
   pull against the ~2 s assumed)".

3. `docs/adr/0037-image-caching-prepull.md:106-110` — the attribution is **not in the cited source**.
   The record (Addendum 4, `:165-166`) gives the number and the "pins track digests" lesson but never
   says the sitting used a hand-rolled DaemonSet, names no sitting id, and no raw ~14 900 ms sample is
   committed under `benchmarks/scale-to-zero-oke/results/` (I grepped: no match). The hand-rolled
   attribution exists only in issue #767's gate ruling. Meanwhile the record's own header says "Both
   digests **pre-pulled and pinned on both nodes (DaemonSets)**", which a reader may read as the
   operator feature. **Why it matters:** the paragraph's central caveat ("do not cite hand-rolled
   DaemonSets as evidence") is itself uncheckable from the ADR's citation, and n=1 with no raw sample
   is exactly the shape this repo insists on being explicit about. Cite the record's **Addendum 4** by
   name and note the attribution's source (#767), so the chain is followable in-tree.

4. `docs/adr/0037-image-caching-prepull.md:103-106` (minor) — "that mechanism is **precisely what
   bounds the exposure**" is true only when the prewarm reconcile *succeeds*. The 2026-08-04 amendment
   in this same file (`:112-138`) establishes the opposite path: a prewarm failure (e.g. operator
   upgraded without DaemonSet RBAC → `Forbidden`) is **degrade-not-fail**, so the pin is silently left
   at the old digest with only `ImageCacheReady`, a counter and a warning alert as signal — an
   unbounded window, not a short one. A half-sentence pointing at the amendment keeps the two sections
   from disagreeing.

## Nit (not blocking)

- This file's convention for post-acceptance changes is a top-level `## Amendment (date, #n)` section
  (three exist). The new text is a dated paragraph embedded in a Consequences bullet instead. That was
  the gate's instruction ("one paragraph in the bullet"), so it is deliberate — noted only because a
  future reader scanning amendment headings will miss it.

## Test quality

Docs-only; no tests expected or added. The two code claims it makes are backed by an existing,
non-tautological envtest (`image_prewarm_envtest_test.go:100-129` — flips the digest and asserts the
DaemonSet followed, with a failure message that states the behaviour), which I verified rather than
took on trust.
