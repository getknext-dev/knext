# Spec review — PR #780 vs #766 + architect-gate ruling — ROUND 2

Reviewer: spec-review (read-only). Date: 2026-08-19. Re-verifying the two round-1 findings only;
all round-1 "met" criteria re-confirmed unchanged (#780's diff is still the same 4 files).

## Round-1 finding 1 — (b2), the knext docs-site half of deliverable (b)

**Round 1: NOT MET, no trail → Round 2: MET.**

Verified in `gh pr diff 773` (branch refreshed, commit e96b279 present). The invariant phrase
occurs exactly **twice** — once per page — and both occurrences carry both required halves:

- `apps/docs/content/docs/learn/scale-to-zero.mdx` (diff file 1, Callout):
  > "If your database runs on a scale-to-zero engine, its idle window must be **at least as long as
  > this delay**, or the warm pod answers instantly and then waits for the database to wake anyway.
  > That idle window is a platform setting your cluster operator owns — it is not configured per app."
- `apps/docs/content/docs/scale-to-zero.mdx` (diff file 2, Callout): same two sentences.

Against the ruling's deliverable (b) second half, both required elements are present and in **user
words**, with no internal references (satisfies the docs rule in memory `docs-user-facing-no-internal-refs`):
1. the ≥ **invariant** — "must be at least as long as this delay" (stated as a requirement, not
   advice: "must be", plus the consequence clause, which is the ruling's "buys nothing on the first
   DB-touching request" in plain English);
2. the **platform-setting** statement — "a platform setting your cluster operator owns — it is not
   configured per app" (the ruling: "states the DB idle window is a **platform** setting the cluster
   operator owns").

**Trail is durable, in both directions:** a comment on #773 records the post-approval docs-only
commit and its provenance ("the #766 architect-gate ruling requires the DB-window alignment rule in
the docs-site section this PR creates… Spec-review trail: #780's spec review flagged the deferral as
otherwise untracked"), and #780's thread records the disposition, including the honest concession
that #773's prior text was the weaker pre-ruling caveat. This is no longer a silent deferral.

## Round-1 finding 2 — (a), the running workaround

**Round 1: partial (comment-only) → Round 2: MET.**

Issue **#781** ("cluster: replace the pg-keepwarm-filemanager trickle deployment with an
AppDatabase warmSchedule window", OPEN, Knext/Backlog) is now the tracked home. It states the
ruling's two steps in order — (1) declare the `warmSchedule` window (the shipped feature), (2)
remove the trickle deployment — names the cluster and namespace (`pg-keepwarm-filemanager`, default,
OKE `context-ckmva7v7zvq`), records that the manifest exists only on the unmerged spike branch, and
correctly attributes step 2 to the human-gated cluster-delete rule. Closing #766 now retires no
requirement.

## Re-confirmed from round 1 (unchanged)

(b1) `appdatabase-api.md` §3b invariant · (b3) `nextapp_types.go:461-472` godoc + regenerated CRD
(description-only drift) · (b4) ADR-0030 addendum, no new ADR · (c) #779 open, nothing decided, no
gateway manifest/code touched · (d1) #777 and (d2) #778 filed, not fixed · (e) no `NextApp` field,
no cross-resource read. No scope drift; 61 added lines, all documentation.

## Verdict: **APPROVE**

Both findings are closed by evidence, not assertion. "Closes #766" is now honest: verdict D
executed here, deliverable (b) shipped in both named places (one here, one in #773 with a
two-way trail), (a) tracked in #781, (c) surfaced in #779 and explicitly undecided.

### Two non-blocking notes for the merger (neither is an unmet criterion)

1. **`docs/adr/0045-*.md:105` still reads `- [ ] Docs cross-reference to #766 (DB window
   independence) when that lands`.** It *has* now landed. Tick it when #773 merges (natural home:
   #773's own commit) — pure bookkeeping, but this file's checkboxes are how the ADR's action items
   are audited later.
2. **(b2) rides an unmerged PR.** #773 is reviewer-APPROVE'd on both gates, so this is low risk, but
   if #773 were ever closed unmerged the docs half would go with it. The trail comments make that
   recoverable rather than silent, which is what round 1 asked for.
