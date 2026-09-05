# Code review round 2 — PR #780 @ 50588d0

**Verdict: APPROVE.** Both round-1 findings are fixed correctly, and the fixes introduce nothing new.

## Finding 1 — unshipped scaffolder stated as fact → FIXED, and the new claim is verified true

`packages/scale-zero-pg/docs/appdatabase-api.md:178-180` now reads
"ADR-0045 has `kn-next create` scaffold `5m` — knext#763, **in review at this writing**", and
`:188` "the 5 m ADR-0045 **scaffolds**" (was "knext's scaffolded 5 m").

Verified, not taken on trust: **PR #773** — "feat(cli): scaleDownDelay flows config→CR and
`kn-next create` scaffolds \"5m\" (#763)" — is `state: OPEN`, `isDraft: false`. So "in review at
this writing" is literally accurate today, and the claim is now caveated rather than asserted as
shipped. The residual present-tense "the 5 m ADR-0045 scaffolds" is attributed to the **ADR**
(which did decide it) and sits two sentences after the explicit pending caveat, so a reader cannot
be misled about ship state. Not worth another round.

One thing this fix does *not* do, deliberately and correctly: it does not touch
`docs/operator/crd-nextapp.md:117`, which carries the same pre-existing uncaveated claim from #769.
That is out of this PR's scope — it will self-resolve when #773 lands, and is only worth a follow-up
if #773 stalls.

## Finding 2 — unsourced "290 ms" → FIXED in both surfaces

- Godoc `nextapp_types.go:463-466`: "(measured on the file-manager spike, #766: 290 ms with the
  compute awake vs ~2.3 s waking it — the wake figure is recorded in
  `docs/benchmarks/fm-same-source-oke-ab-2026-08-18.md`)".
- Doc `appdatabase-api.md:185-187`: same, with the cross-repo qualifier "in the knext repo" —
  correct, since that path does not exist in the scale-zero-pg package.

Both citations resolve: `docs/benchmarks/fm-same-source-oke-ab-2026-08-18.md:35` = "~2.3 s PG wake
on its first render", and the 290 ms figure is now attributed to its only real source (the #766
issue body's spike measurement) rather than presented as an unlocatable "measured:". Attribution,
not fabrication of a record — the honest fix.

## Mechanical re-verification at 50588d0

- **`make manifests` → zero diff.** Ran controller-gen on the fetched commit; `git status` reports
  no tracked modification afterwards. The 4 changed CRD description lines are exactly the
  regenerated wrap of the new godoc text — the yaml hunk matches the Go hunk word for word.
- **`gofmt -l api/v1alpha1/nextapp_types.go`** → clean; **`go vet ./api/...`** → clean.
- Diff `51527cc..50588d0` touches only comment text, the generated description, and markdown prose.
  No field, no behaviour, no validation, no schema change, no decision on #779.

Everything cleared in round 1 (godoc numbers vs the ruling, "each operator evaluates its own" vs the
`warmSchedule` godoc + ADR-0030 addendum, `GW_IDLE_MS` 60000/300000 citations, the no-`minWarm`
reason against the RBAC and `ApplyCompute`, the ≥-invariant against the 10 s pool idle timeout,
ADR-0045 §Consequences forward-referencing #766, and the ADR-0001 boundary claim) is unchanged by
this commit and still holds.

## Test quality

Still no tests, still correct — comments and prose. The one mechanical guard that applies
(CRD-vs-godoc regeneration) I re-ran myself on the new commit rather than trusting the commit
message's "CRD regenerated".
