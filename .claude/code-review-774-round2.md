# Code review round 2 — PR #774 @ ac234c7 (002cf06 + ac234c7 on 19b90b6)

## Verdict: APPROVE

Both round-1 findings are genuinely fixed, not papered over. Behaviour is untouched between 19b90b6
and ac234c7 (`git diff --name-only` = the ADR + comment-only hunks in `nextapp_controller.go`), so
round 1's correctness verification and mutation proof still stand; the `delete(annotations,
"autoscaling.knative.dev/scale-down-delay")` line is intact at `nextapp_controller.go:875`.

## (a) No enumeration outside the disposition list — CONFIRMED
- `git grep "rewrites only" ac234c7` → **empty** repo-wide.
- `nextapp_controller.go:794-797` (TBC) and `:808-810` (panic pair) now state only their own fate
  ("PASSED THROUGH") and point at the single list, with an explicit "do not restate the list here".
  That is the right shape: one enumeration, N pointers.
- No other file restates what the override *does to a stamped annotation*.

## (b) ADR agrees with the code — CONFIRMED
- Decision 1 now reads "…stamps … on the revision template — **non-preview revisions only**
  (amended by #770 …)". That is exactly what `:832` + `:875` do.
- The Consequences bullet's factual claims all check out against the tree: forced max-scale=1 /
  min-scale=0 / 30s retention (`:872-874`), drop-not-clamp, no duration parsing at the use site,
  envtest-gated (`reconcile_output_test.go:1061+`, which I mutation-proved red in round 1).
- Design-gate disposition (consequence-level refinement, Decisions 1–5 intact) is reasonable on the
  evidence: the amendment narrows one clause of Decision 1 and adds a Consequence; nothing in
  Decisions 2–5 is contradicted.

## (c) gofmt / vet / build / tests at ac234c7 — CONFIRMED
Run in a throwaway detached worktree at ac234c7 (removed and pruned afterwards):
`gofmt -l ./internal ./api` empty · `go vet ./...` clean · `go build ./...` clean ·
`go test ./internal/controller/... -count=1` **ok (33.1s)** on envtest 1.36.2.
CRD needs no regeneration — `api/v1alpha1` is byte-identical to 19b90b6, where I already proved
`controller-gen` produces zero drift.

## Two non-blocking notes (do not hold the merge)
1. `docs/adr/0045-scale-down-delay.md:3` — Status is still "**Proposed** (2026-08-19)" although the
   implementation merged (#769) and is now being amended. `workflow.md` says amendment/supersession
   status is read from the ADR front-matter, not from body text, and ADR-0044's header is the repo's
   own precedent ("Accepted … Amendment 1 Accepted"). A reader scanning statuses will not see that
   #770 amended this ADR. Pre-existing "Proposed" drift is not this PR's fault; adding an
   "amended by #770" clause to the Status line when the status is next touched would close it.
2. `packages/kn-next/src/cli/cr-builder.ts:18`, `cli/preview.ts:20`,
   `src/__tests__/preview-cr.test.ts:5` still describe preview mode as "(max-scale=1, min-scale=0,
   30s retention, environment=preview / pr-id labels)". Those are *forced*-knob summaries and carry
   no "only", so nothing there is false today — but they are the next drift candidate once #773 puts
   `scaleDownDelay` on the CLI surface. The clause belongs on #773's branch, where the CLI knows the
   field; noting it here so it is not rediscovered as a third leak.
3. Round-1 finding 3 (scanning guard) is correctly filed as #775 rather than bolted on here.

## Test quality (one line)
Unchanged from round 1 and still strong: reconcile-output assertions, both halves from one spec,
independently mutation-proved red on the exact leak; these two commits add no tests because they
add no behaviour.
