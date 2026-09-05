# Code review — PR #786, round 2 (fix/tier-warm-on-warmhold)

**Reviewed range:** `cd74257..7446291`. The branch moved *while I was reviewing*: the lead's brief
named `61da794` as head, and `7446291` ("the hold knob is APPDB_GATEWAY_HOST and a released gauge is
an absent series, not 0") landed mid-review at 15:12. Everything below is verified against `7446291`
— two of my round-2 findings were already fixed by that commit and are recorded as closed rather
than raised.

## Verdict: **ISSUES_FOUND** — one open defect, both round-1 HIGH/MED fixes verified genuine

Nothing here re-opens the round-1 HIGH. The withdrawal fix is real, mutation-proved, and the round-1
test tautology is closed. The one open item is a drill instruction that cannot be followed as
written, in the doc that gates the OKE verification this PR still owes.

---

## Open

### 1. LOW/MED — `docs/drills/tier-warm-drill.md:69-73` — the negative half's simplest method contradicts its own assertion
> "Make the hold fail (**simplest: scale the apps gateway to 0 briefly**, or point the operator at an
> unreachable `APPDB_GATEWAY_HOST` in a scratch namespace). Assert: … **a fresh `psql` still works
> via the ordinary cold wake**."

`psql` reaches the app database *through* the apps gateway (`pggw-apps`, the DSN host in
`app-db-<app>`), so with that Deployment at 0 the third assertion cannot pass — the drill's own
degrade-not-fail claim would read as a failure. Only the second method isolates the *hold* from
serving. Drop the "scale the gateway to 0" option (or mark it as breaking serving too, in which case
the psql assertion is void for it). This is the drill of record for the pre-merge OKE battery, so a
step that self-contradicts costs a re-run.

### 2. LOW — `gateway/internal/appdb/reconcile.go:193-198` — "That is latency, not a leak" is true only for a *transient* step-5 fault
The new comment is honest about the trade the ordering move creates, and I verified the trade is
real: with a probe that withdrew warmth in the same pass as a pageserver fault (`failLSN`), reconcile
returned `read template lsn: boom` at step 5 and the hold survived —
`held=map[app1:true] released=[]`, `WarmHold` still `True/TierWarm`. Requeue is true, so a blip
self-heals within a tick and the comment's claim holds. It does **not** hold for a *sustained* step-5
error (pageserver down, template plane never initialised, `Branch` failing): both the ensure and the
withdrawal release are skipped for the whole outage, i.e. a withdrawn hold does persist — bounded by
pageserver recovery, not by a resync tick. Either soften the wording to that bound, or (cheap, and
strictly better) run the **release** before step 5 and keep only the **ensure** after it — the
release needs no branch, which is the whole reason the ordering constraint exists.

---

## Closed by `7446291` (raised in draft against `61da794`, verified fixed — recorded so they are not lost)

- **`GW_APPS_HOST` did not exist.** The drill precondition, the drill §2 method and the new
  `operations.md` `HoldsUnavailable` bullet all named an env var absent from the tree; the real dial
  target is `APPDB_GATEWAY_HOST` (`cmd/appdb-operator/main.go:69`), and `Holds` is wired
  unconditionally (`main.go:116,122`), so `HoldsUnavailable` is unreachable in the shipped binary.
  `7446291` corrects all three sites and re-frames the reason as an embedder-build signal. Correct.
- **"the gauge drops to `0`".** The exporter emits a series only for held apps
  (`main.go:155-168`) — on release the series is **absent**, there is no `0` sample, so
  `# expect value: 0` was un-runnable (`grep` exits 1). `7446291` fixes it in the drill,
  `operations.md` and `appdatabase-api.md`, and explicitly documents "grep exiting 1 here is the
  pass". Correct.
- `7446291` is titled `docs(...)` yet touches two `.go` files — I diffed them: **comment-only**
  (`main.go` block comment, `reconcile.go` ordering rationale). No behaviour change, so no TDD
  obligation. Suite re-verified green at that commit.

## Attacked and found sound

- **(1) Withdrawal release idempotent + reachable without status.** Probed the exact hazard the code
  comment claims to cover: hold present in the manager, CR status carrying **no** `WarmHold`
  condition (the pass that established it failed its status write), tier `cold` →
  `released=[app1]`, `held=map[]`. Ungated by status, as advertised. Repeated withdrawal passes
  churn nothing: one condition, one `lastTransitionTime`, zero events across 4 passes. Delete after
  withdrawal is still clean.
- **Mutation-proved, all three restored green afterwards (anchor-asserting script, never bare perl):**
  - remove the withdrawal `ReleaseHold` ⇒ `TestTierWarm_FlipToColdReleasesTheHoldAndRetractsTheCondition`
    + `TestWarmHold_RemovingTheLastWindowReleasesTheHold` red;
  - remove the `WarmthNotRequested` retraction ⇒ same two red (so both halves of the guard are
    asserted — this repo's most common defect class, avoided here);
  - **move the whole 5c block back above step 5** ⇒ `TestTierWarm_FirstPassDoesNotFailTheHoldBeforeTheBranchExists`
    red. The ordering guard is not decoration; `branchGatedHolds` models the real failure (dial
    against a timeline the pageserver does not have) rather than asserting a line number.
- **(3) Successive-round regression sweep.** The only new coupling the fix introduces is finding #2
  above; nothing else regressed. Back-compat is now asserted more strongly than before
  (`TestTierCold_UnaffectedByTheWarmTierHold` and `TestWarmHold_NoScheduleMeansNoHoldAndNoCondition`
  both check a *second* resync pass for condition/event churn, which is the right shape for an
  unconditional-release design). Cold CRs still never dial and grow no condition.
- **Round-1 test tautology is closed.** `TestTierWarm_StaysWarmPastTheIdleWindowThatUsedToDegradeIt`
  now `delete(fh.held, …)` between passes; re-running my round-1 "fire once, never re-establish"
  mutation now reds **that** test (round 1: it stayed green, only a pre-existing test caught it).
- **Red proof re-verified independently**, not taken on report: `git worktree add --detach e17e2be`
  ⇒ exactly 3 failures, the 3 new tests. Temp worktree removed, `git worktree prune` run.
- Full gateway suite green (9 packages), `gofmt -l` clean, `go vet ./...` clean at `7446291`.
- Docs sweep: no script parses the renamed printer column (all drills use `-o jsonpath` on
  `.status.*`); no drill asserts `computeReady`; `pggw_system_wake_budget_exceeded_total{system=…}`
  cited in the new runbook bullet exists (`internal/metrics/metrics.go:215`); `86-zone-crd.yaml`,
  `60-prometheus.yaml`, `spikes/133` and `DRILLS.md` all now describe the hold, not a replica floor.
  Single-writer still intact — no replica/Scale write anywhere in the round-2 diff.

## Test quality
Better than round 1. The three new tests each assert observable state (hold released, condition
retracted to `False/WarmthNotRequested`, no `WarmHoldFailed` on a first-pass create) and each is
individually mutation-sensitive; the ordering test uses a behavioural fake rather than an ordering
assertion, and the back-compat tests now pin *absence of churn* across passes, which is what an
unconditional release needs. Remaining gap, minor: nothing covers withdrawal colliding with a
step-5 error (finding #2) — that is the state the new comment asserts is benign, and it is asserted
only in prose.

---

**Process note for the lead (not a code finding).** The implementer was editing this worktree while I
ran mutations in it — `reconcile.go`/`main.go`/the drill doc were dirty at 15:12, then committed as
`7446291`. My mutation restores (`git checkout -- internal/appdb/reconcile.go`) predate those mtimes,
so nothing was clobbered, but this is precisely the shared-worktree hazard the workflow file records
(a restore silently reverting someone's in-flight work). One worktree, one owner — either the
reviewer copies out, or the implementer stops while mutations run.
