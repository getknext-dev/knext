SIGN-OFF

# System-designer sign-off — PR #786 through `41e9313` (docs-only delta `0d8f900..41e9313`)

Supersedes nothing in `.claude/sysdesign-signoff-786-round2.md` — that verdict stands; this
extends it over the architect-gate docs commit. **Verified the delta touches no code:**
`git diff --stat 0d8f900..41e9313` is five `.md` files (`docs/adr/0030`, `docs/guides/database-platform.md`,
`adr-0006-unified-config.md`, `getting-started.md`, `operations.md`). The round-2 test evidence
(red at `7bf3120` for the persisted condition, green package at `0d8f900`, gofmt/vet clean) therefore
carries forward unchanged.

## The delta, checked against the code rather than against the commit message

- **ADR-0030 addendum (dated, Accepted).** Records (a) tier-as-permanent-hold and (b) the precedence
  rule. Both match the implementation at this commit: `reconcile.go:412-415` sets `permanent` and
  leaves `invalid` **nil** when the tier is warm, so the `InvalidWarmWindow` branch at `:434`
  (`len(invalid) > 0`) genuinely cannot fire on a warm-tier CR — the addendum's "a malformed window
  on a warm-tier CR is inert (no `InvalidWarmWindow` event)" is a true statement about the code, not
  an aspiration. "`Ready` carries `WarmHeld`/`WarmHoldDegraded` **for the warm tier only**" matches
  the switch at `:366`/`:370`. The addendum also carries the fleet-cost pointer forward, which is
  what I wanted BLOCK 2 to leave behind in a decision record rather than only in a runbook.
- **`adr-0006` Tier comment / `database-platform.md` row.** The replaced parked-replica mechanism is
  gone from both. `adr-0006` keeps the historical wording explicitly quoted and marked historical —
  the right way to retire a claim, since it lets a reader who remembers "~0.4 s wake" find out what
  happened to it instead of silently disagreeing with their memory.
- **`READY` → `COMPUTE` sample headers** (`operations.md:1633`, `getting-started.md:166`) now match
  the CRD's printer columns at this commit (`82-appdb-crd.yaml:42`, `{ name: Compute … .status.computeReady }`),
  and `getting-started.md` adds "(diagnostic; not a readiness gate)" — the demotion is now visible at
  the first place a new operator meets the column, which is where it matters.

## Correction to my own round-2 write-up

I cited the `Ready` switch as `reconcile.go:334-352`; at this commit it is **`:366`/`:370`**. The
finding was right, the line reference was not — a stale cwd, not a stale reading. The other
citations re-verified clean at `41e9313`: withdrawal persist `:187-199`, `controller.go:86,93`
(fresh `List` + decode per pass, which is what makes the transition guard's retry sound),
`gateway.go:96,169,259`, `k8s.go:227,276`.

## Follow-up filed, and it is the right shape

#787 (capacity alert: `sum(appdb_warm_hold_active)` vs `GW_MAX_CONNS`) is the correct home for my
BLOCK 2 residual. It converts the drill's manual "watch `pggw_rejected_connections_total` alongside
warm-app count" into a signal that fires before the wall rather than after — and it fires on the
*cause* (holds approaching the shared budget) rather than the *symptom* (other tenants refused
`53300`), which is the difference between a warning and a postmortem. Not a merge blocker: the
ceiling is now documented and measurable, which was the BLOCK.

## One follow-up nit this commit creates (not blocking)

`docs/guides/database-platform.md` is user-facing and its warm row now describes the **AppDatabase**
mechanism ("the platform holds it awake … no wake at all"), but the paragraph above it points readers
to `connecting.md` for "the tier table" — and that table (`connecting.md:44-77`) describes the
*other* warm tier: the single-DB plane's `compute-warm` warmpool (`deploy/25-compute-warm.yaml`,
`GW_COMPUTE_MODE=warmpool`, "always-warm (park a pod 24/7)", opted in with
`kubectl scale deploy/compute-warm --replicas=1`). Both mechanisms are real and both are called "warm
tier"; before this commit the guide row and that table agreed (both said parked pod), and now they
do not. The concrete hazard is an app owner following the link and scaling the **shared** single-DB
compute when they wanted a warm `AppDatabase`. Smallest fix, whenever the guide is next touched:
point the warm row at `appdatabase-api.md` §2a (or at `connecting.md`'s apps-plane section, which
already covers `warmSchedule`/`WarmHold` correctly), and note in `connecting.md:44` that its table is
the single-DB plane's tier, not `AppDatabase.spec.tier`. Docs-only, no invariant, no code — a nit,
not a BLOCK.

## Sign-off questions — unchanged and clean

Data sovereignty (own-DSN from own Secret, host from env), single writer of replicas
(`desiredReplicas()==0` + preserve-on-update + no `deployments/scale` grant), security
(authenticated SCRAM, `redactDSN`, no new mutating endpoint), failure modes (degrade-not-fail,
release-before-pageserver on withdrawal, crash-only re-establish, persisted retraction with a sound
retry), core-vs-app boundary (untouched — this is all `packages/scale-zero-pg`).

**Verdict: SIGN-OFF at `41e9313`.**
