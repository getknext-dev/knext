# Spec review — PR #780 vs issue #766 + the architect-gate ruling

Reviewer: spec-review (read-only). Date: 2026-08-19.
Scope reviewed: `gh pr diff 780` (4 files, +61/-0), issue #766 + both comments (the ruling and the
deliverable-(a) trail), #773/#777/#778/#779, ADR-0045 action items, `apps/docs/content/docs/**`.

## Checklist

| # | Criterion (from the ruling) | Verdict | Evidence |
|---|---|---|---|
| (a) | Delete the workaround, use the feature — replace `deploy-spike/pg-keepwarm.yaml` with an `AppDatabase.spec.warmSchedule` window | **partial (trail exists, work not done or tracked)** | Issue #766 comment 2 (2026-08-19) states: manifest lives only on unmerged `spike/file-manager-on-vinext` (verified: `git show origin/spike/file-manager-on-vinext:apps/file-manager/deploy-spike/pg-keepwarm.yaml` exists; nothing on this branch — `git grep pg-keepwarm HEAD` hits only `docs/benchmarks/fm-same-source-oke-ab-2026-08-18.md`), deployment `pg-keepwarm-filemanager` still running on OKE, cluster deletes human-gated. **Not silently dropped** — the trail is explicit and honest. But step (1) of the ruling ("declare a `warmSchedule` window on the file-manager `AppDatabase`" — the actual "use the feature" half) is neither done nor filed anywhere, and its only record is a comment on an issue this PR closes. |
| (b1) | Alignment rule as an invariant in `appdatabase-api.md` | **met** | `packages/scale-zero-pg/docs/appdatabase-api.md` §3b (heading at :150, paragraph inserted at :173+): "an invariant, not advice… **the gateway's idle window must be ≥ the app's `scaleDownDelay`**…", names the 60 s-vs-5 m asymmetry, records "no `minWarm` … and none is planned" with the single-writer reason, points at #779. |
| (b2) | Same rule in the knext docs page ADR-0045 action-item 3 creates | **NOT MET — and no trail** | PR touches no file under `apps/docs/`. PR body never mentions #773, the docs site, or a deferral. `docs/adr/0045-*.md:105` still reads `- [ ] Docs cross-reference to #766 (DB window independence) when that lands` — unchecked, untouched by this PR. #773 (unmerged) *does* create the page, but its text is the weaker pre-ruling caveat, not the invariant: `apps/docs/content/docs/scale-to-zero.mdx` Callout — "The delay also covers the **app only** — a database that sleeps when idle keeps its own wake time" (same sentence in `learn/scale-to-zero.mdx`). Neither the **≥ invariant** nor "the DB idle window is a **platform** setting the cluster operator owns" appears anywhere in #773's diff (grep for `GW_IDLE`, `AppDatabase`, `#766` in `gh pr diff 773`: zero hits). So the deferral is not merely unmerged — the deferred-to PR does not contain the deliverable. |
| (b3) | knext godoc paragraph on `ScaleDownDelay` (the "what the knext side owes" half) | **met** | `packages/kn-next-operator/api/v1alpha1/nextapp_types.go:461-472` — pod-routable-not-DB, measured 290 ms vs ~2.3 s, "INDEPENDENT BY DESIGN (ADR-0030 addendum shape)", the ≥ alignment rule, points at `AppDatabase.spec.warmSchedule`, ADR-0001 boundary. CRD regenerated with description-only drift (`config/crd/bases/apps.kn-next.dev_nextapps.yaml:432+`, identical text). |
| (b4) | ADR follow-up: amend **ADR-0030's** addendum, no new ADR | **met** | `docs/adr/0030-scheduled-warm-floor.md:281-293` "The on-demand sibling (2026-08-19, #766 ruling)" — clock- vs traffic-triggered halves, `minWarm` rejection reason, `idleDelay` shape pre-ruled, #779 named. No new ADR added; ADR-0045 not amended (correct per the ruling's parenthetical). |
| (c) | `GW_IDLE_MS` divergence **surfaced, not decided** | **met** | #779 open ("GW_IDLE_MS shipped-manifest 60s vs code-default 300s vs app-side 5m — a costed platform decision"), body says "explicitly NOT decided there". Diff touches no gateway manifest/code (`deploy/81-apps-gateway.yaml`, `gateway.go` absent from the 4-file diff); `appdatabase-api.md` §3b defers to #779 rather than choosing. |
| (d1) | As-built defect 1 (`tier: warm` inert) **filed, not fixed** | **met** | #777 open, Backlog. No Go changes in the diff; `desiredReplicas`/`ApplyCompute`/`warmhold.go` untouched. |
| (d2) | As-built defect 2 (docs assert "one hot replica") **filed, not fixed** | **met** | #778 open, Backlog. `appdatabase-api.md:42` (`tier: cold … | warm (one hot replica)`) and §2 unchanged — the diff only appends to §3b. |
| (e) | No `NextApp` field, no cross-resource check, no knext read of `AppDatabase` | **met** | Diff adds zero struct fields (`ScaleDownDelay string` unchanged at the same line, comment-only hunk); CRD delta is description text only; no controller/validation code touched. |
| (f) | "Closes #766" honesty = documentation-only matches what the gate ruled | **partial** | Verdict D ("no new field") is executed faithfully and the PR body's "Why no field" reproduces the gate's four facts accurately. But the ruling says #766 *closes with* (a)+(b)+(c); merging this closes the issue with (b) half-shipped and (a) parked in a comment on the now-closed issue. |

## Scope drift
None found. 61 added lines, all documentation/godoc; nothing built that the ruling did not ask for.
Design-gate triggers (`docs/adr/`, `nextapp_types.go`/CRD) are tripped but covered — the gate ran
pre-implementation on this exact question and the PR carries `design-gate:cleared`.

## Verdict: **ISSUES_FOUND**

Two items, one blocking-ish, one minor.

1. **(b2) — the knext-side half of deliverable (b) is silently dropped.** The ruling names *two*
   places for the alignment rule; only one ships. There is no trail: the PR body does not mention
   the docs page, #773, or a deferral, and `docs/adr/0045-*.md:105`'s action-item checkbox is
   untouched. Worse, the natural assumption ("#773 will carry it") is false on inspection — #773's
   Callout states a weaker, pre-ruling caveat and contains neither the ≥ invariant nor the
   "platform setting the cluster operator owns" statement. Closing #766 therefore retires the only
   record of the requirement. **Fix (either is sufficient):** (i) add the two sentences to
   `apps/docs/content/docs/scale-to-zero.mdx` + `learn/scale-to-zero.mdx` here (they exist on this
   branch — #773 edits them, it does not create them, so there is no merge-order excuse), or
   (ii) if it must ride with #773, say so in the PR body **and** leave a durable trail — a comment
   on #773 requesting the sentence, plus ticking/annotating ADR-0045 action item 3. A deferral
   whose only record is a reviewer noticing it is a drop.
2. **(a) — minor.** The trail comment is good practice and correctly scoped (nothing to delete from
   `main`; cluster deletes are human-gated). But the ruling's product answer — declare the
   `warmSchedule` window on the file-manager `AppDatabase` — is unowned once #766 closes. Recommend
   a one-line follow-up issue (or a checkbox on #779) so the running `pg-keepwarm-filemanager`
   residue has a tracked home rather than a comment on a closed issue.

Everything else — (b1), (b3), (b4), (c), (d1), (d2), (e) — is met by the code quoted above.
