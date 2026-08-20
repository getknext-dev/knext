# Code review — PR #786, round 4 (final) — head `bcd87a1`

## Verdict: **APPROVE**

`7cd554c..bcd87a1` is the drill doc only (18/6 lines, one file). Every claim in it checks out against
the tree, and each of the four defects raised across rounds 1-3 is fixed at the mechanism, not
papered over.

## The round-3 LOW — closed, and the replacement method is correct

I verified each load-bearing claim in the new §2 rather than accepting it:

- *"the hold dials the DSN stored in the app's Secret … minted once"* — `main.go:116`
  (`NewHoldManager(cluster.DatabaseURL, …)`) → `k8s.go:160-169`; step 3 mints only when absent,
  `EnsureSecretOwnerRef` touches ownerRefs only, `EnsureSecretROKey` patches only
  `DATABASE_URL_RO` (`k8s.go:119-147`). The writer key is never rewritten. ✔
- *"a live hold is healthy TCP and is not redialled"* — `EnsureHold` pings the held conn first and
  returns on success, never re-reading the DSN (`warmhold.go:96-109`). So the restart is **required**,
  and the doc says so. ✔
- *"an operator restart drops all holds (crash-only) and the redial uses the patched DSN"* — the
  manager is an in-memory map (`warmhold.go:71-77`); a fresh process re-reads the Secret. ✔
- *"serving stays independently assertable with the Secret's separate `PGUSER`/`PGPASSWORD` keys"* —
  both keys exist (`k8s.go:73-74`), so a `psql` against the real gateway host is genuinely
  independent of the poisoned `DATABASE_URL`. That is what keeps the degrade-not-fail assertion
  falsifiable, which was the whole point. ✔
- *"Restore the Secret's `DATABASE_URL`; within one resync tick the hold re-establishes"* — correct
  and no second restart is needed: a failed hold is not in the map, so the next `EnsureHold`
  re-reads the Secret. ✔

The live OKE run is the stronger proof, and it landed the right way round: the broken method was
executed first and was inert exactly as predicted (no `HoldFailed`, no event), then the corrected
method produced `WarmHold False/HoldFailed` + a fresh `WarmHoldFailed` (dial `unreachable.invalid`),
`Ready True/WarmHoldDegraded`, and a served `select 1` through the real gateway while degraded. That
is the degrade-not-fail contract demonstrated on the running system, not asserted in a unit test.

## Final state at `bcd87a1`
- Full gateway suite green (9/9 packages), `gofmt -l` clean over `internal` + `cmd`, `go vet ./...`
  clean, worktree clean.
- Single-writer intact across the whole PR: `desiredReplicas()` is 0 for both tiers and no
  replica/Scale write appears in any of the eight commits — the #766 ruling holds.
- No secrets in the diff; `redactDSN` still wraps every error reaching a condition, Event or log.

## Round ledger (what the adversarial passes bought)
1. **HIGH** — `tier: warm → cold` leaked the hold forever, blinding `ComputePhantomKeepalive` via its
   own stale gauge subtraction. Fixed, mutation-proved both halves (release *and* retraction).
2. **MED** — the first `EnsureHold` dialled before the pageserver branch existed. Fixed; the guard
   reds when the block is moved back.
3. **MED** — round-2's fix made withdrawal hostage to a sustained pageserver fault. Fixed by
   splitting release (4c, before) from ensure (5c, after); ordering-guarded by a test whose red I
   reproduced and whose mutation I ran.
4. **LOW ×3** — a tautological test (closed), an invented env var + a `0`-that-never-exists in the
   runbook/drill (closed), and a drill method that could not fail the hold (closed, then confirmed
   inert on the cluster).

No open items. Approved to proceed to architect / system-designer sign-off.
