# Code review round 2 — PR #776 @ 1d0dac8 (+ 8e2919a)

**Verdict: APPROVE.** All four round-1 findings are genuinely addressed, not papered over, and every
quoted number/phrase in the rewritten paragraph resolves to a real line in this ADR or the cited
record. Three sub-0.1-severity nits below, none blocking.

## Round-1 findings — re-verified closed

1. **Tail framing (was: contradicts the ADR's own tail statement).** CLOSED. `:105-106` now reads
   "the tail the action items below already warn about ('holds at the median and understates the
   tail', max-to-max +10.7 s), realized and exceeded". Quote verified **verbatim** against `:289`
   ("holds at the median and understates the tail, compared like for like: p75 to p75 is +3.9 s and
   max to max +10.7 s") and "below" is directionally correct (Consequences → Action items). The
   comparison is now **delta vs delta** (+12.6 s vs +10.7 s), so "exceeded" is arithmetically true
   rather than a category swap. This is the corroboration framing I asked for.
2. **Like-for-like (was: total TTFB compared to a pull component).** CLOSED. `:100-105`: "14.9 s
   end-to-end", pinned cold median stated as the record's own number, "this ADR's own model predicts
   **~4.2 s**" — verified verbatim at `:15` ("cold-image cold start (fresh node / new digest /
   evicted layer) ≈ **4.2 s**") — and the increment is now stated as "≈ +12.7 s of pull where the
   model assumed ~2 s". The `~2 s` is correctly labelled as the *model's assumption*, not as a
   measured total. The ~7×/6.5× ratio was dropped entirely, which is better than pinning it: the
   record supports 4.0×–7.0× depending on which arm you baseline against.
3. **Attribution (was: not in the cited source).** CLOSED, and honestly. `:101-103` names **Addendum
   4** specifically, states "a single sample with no raw file committed" (matches my grep — no
   ~14 900 ms sample exists under `benchmarks/scale-to-zero-oke/results/`), and `:115-117` credits
   the hand-rolled attribution to the **#767 gate ruling** while quoting the record's own weaker
   sentence verbatim — "prepull pins track digests: they pin what they are told, not what is
   deployed" matches `fm-confirmatory-prepulled-ab-2026-08-18.md:165-166` exactly. A reader can now
   follow the chain and see precisely where the evidence stops and the ruling begins.
4. **Bound conditioned (was: "precisely what bounds the exposure").** CLOSED. `:106-111`: "the window
   stays short only **while the re-pointing mechanism runs**", then the 2026-08-04 degrade-not-fail
   amendment is cross-referenced with the right consequence — "the pin silently stays at the old
   digest … and in that state the window is unbounded — at this price". Checked against the amendment
   (`:120-146`) and the code: a failed `CreateOrUpdate` (`image_prewarm.go:222-234`) leaves the
   DaemonSet at the previous digest, the error goes to `imageCacheState.reconcileErrMsg` rather than
   `Reconcile`'s return, and `ImageCacheReady` + `KnextImagePrewarmFailing` are the signals. Accurate.

## Still verified from round 1 (re-checked at this SHA)

- `image_prewarm.go:177` (`Image: app.Spec.Image`) reached through the mutate fn at `:222-230` — the
  "CreateOrUpdate over `app.Spec.Image` on every reconcile" claim holds.
- Envtest name quoted at `:108` matches `image_prewarm_envtest_test.go:100` verbatim; the test asserts
  the DaemonSet image equals `image2` after a digest flip (`:127`), not a tautology.
- Markdown nesting intact: the whole block is a 2-space-indented continuation paragraph of the
  `- **Interaction with revisions/rollout:**` bullet, blank-line separated, followed by the `##`
  amendment heading at column 0. Renders as one nested paragraph.

## Nits (not blocking, no re-round needed)

- `:105` — "≈ **+12.7 s**" against the stated 2.28 s comparator is 12.62 s. 12.7 is what you get from
  Addendum 4's own sitting median (~2.23 s), which is arguably the more correct baseline anyway. The
  `≈` carries it; only noting so the number's derivation is not mistaken for 14.9 − 2.28.
- `:103` — "that record's pinned cold median is 2.28 s (n=5)" quotes the record's **fastest** pinned
  configuration (multi-warm, Addendum 3 `:108`). The same record also carries 2.355 s (fast mode),
  2.635 s (vinext arm) and 3.685 s (node arm). Picking the fastest maximizes the stated delta by up
  to ~1.4 s. The conclusion survives the worst case — against the node arm the delta is +11.2 s,
  still above the +10.7 s tail — so this changes nothing, but a reader diffing the two documents will
  notice the choice.
- `:99` vs the record — the paragraph is headed "Measured (2026-08-18…)" while the addendum carrying
  the number is dated **2026-08-19** and attributes it to an unnamed "sampling sitting". The sitting
  is plausibly the 08-18 one (the file's subject), and the paragraph already discloses that no raw
  file exists, so this is disclosed ambiguity rather than a hidden one.

## Test quality

Docs-only; no tests expected. The two code assertions the paragraph makes are anchored to real,
non-tautological operator coverage (`image_prewarm_envtest_test.go:100-129`), which I re-verified at
this SHA rather than carrying forward from round 1.
