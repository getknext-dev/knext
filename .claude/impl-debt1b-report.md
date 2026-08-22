# impl-debt1b report — #797 validator early-death + #793 dup fsGroup

Branch `fix/validate-aggregate` (from origin/main c1b962d), worktree
`/Users/banna/alpheya/pocs/knext-wt/validate-aggregate`. Commit `bbbedbb`, pushed. No PR (per brief).

## What shipped

### #797 structural half — `packages/scale-zero-pg/deploy/_validate.sh`
The script was `set -eu` with `fail() { echo; exit 1; }` — the first failing check killed the
run and every later contract passed by absence (the repo's named decorative-guard class).
Restructured:

- **`fail()` records and returns**; the script always reaches a single summary at the bottom,
  prints every failure in one aggregated report, and exits 1 iff any contract failed. Exit codes
  stay CI-faithful: 0 = all pass, 1 = ≥1 contract failure, 70 = premature abort (below).
- **`set -e` dropped (deliberately, commented in-file)** — under set -e any future unguarded
  failing command reintroduces the early-death class. `set -u` kept.
- **EXIT-trap tripwire**: if the script exits before the summary (a future `set -e`, stray
  `exit`, re-exiting fail), the trap reports "exited BEFORE evaluating all contracts" and exits
  70 — a reintroduced mid-run abort can never again read as a pass.
- **`ok()` is failure-aware**: a contract block that failed prints `not ok - … (FAILED)` instead
  of its old trailing ok-line (which would now have lied, since fail no longer exits).
  `blockdone` closes the section-1 per-file failure paths so the next file's ok-line is not
  blamed for a previous file's failure.
- **kubectl missing = one recorded failure**, section 1 + the 2c HPA dry-run skipped explicitly;
  the 30+ grep contracts still run. Previously kubectl-missing aborted everything.
- The **premature mid-script "all checks passed"** (printed before 20 further contracts) is gone;
  the single honest summary is at the end. The unguarded `WANT_PROM_HASH=$(…)` assignment
  (a latent early-death under set -e) is now guarded.

### Two stale contracts the aggregation immediately surfaced (both fixed)
1. **Contract 19 phantom-keepalive anchor** — re-pinned to the rule form #777/#791 deliberately
   shipped (`min_over_time((sum(pggw_active_connections) - …` with the warm-hold subtraction).
   #797's comment requires this resolved before the wiring lands "or the wiring lands red"; the
   repo had already ratified the semantics (the alert's own comments + contract 32 asserts the
   subtraction and `or vector(0)`), so this is a check-sync, not a new alerting decision.
2. **Contract 31 `optional:true` scan** — was whole-file; went stale when the deliberately
   optional + fail-safe `compute-jwt-trust` JWK env refs landed in 20/25/26 (absent → entrypoint
   locks the control API with a throwaway anchor). Scoped to the `pg-base-admin` ref (+3 lines,
   flow and block style). The actual invariant (pg-base-admin CLOUD_ADMIN_MD5 fail-closed) holds.

### #793 — `60-prometheus.yaml` duplicate `fsGroup`
Deleted the second `fsGroup: 65534` in the Prometheus Deployment pod securityContext (kept the
first). Both were 65534, so deployed behavior is unchanged; the prom-config-hash annotation is
over the ConfigMap **data** only, so no re-hash needed. Proven: python SafeLoader with dup-key
detection now strict-parses `60-prometheus.yaml` (and `88-loadsoak-k6.yaml`) clean.

### #797 YAML half — already fixed on main
`88-loadsoak-k6.yaml`'s raw-parse failure (unquoted `${VAR}` in a flow map) was fixed by #796
(placeholders quoted at source + the render-then-validate branch). Verified: strict-parses clean.
Nothing further to do there.

## Mutation proofs (harness: scratchpad `mutation-proof.sh`; branches on exit codes only, anchors count-asserted before substitution, run after committing green)
- **a. baseline green**: exit 0 with a stub kubectl (all applies succeed) — the green path exists.
- **b. early-file failure** (`20-compute.yaml` replicas 0→1, contract 2): exit 1 + reported.
- **c. late-file failure** (`82-appdb-crd.yaml` warmSchedule removed, contract 32 — the LAST
  contract): exit 1 + reported.
- **d. BOTH in one run**: exit 1, both messages in the same report, summary counts
  `2 FAILURE(S)`, and contract 2 prints `not ok` (no lying ok-line).
- **e. tripwire**: `exit 0` injected after contract 5 → exit **70** + loud early-death message
  (the reintroduced-abort class cannot pass).
- **f. restored clean** (git checkout), green again; worktree diff-clean.

Hermetic no-kubectl run: exit 1, exactly one recorded failure (kubectl), all 38 contract blocks
still evaluated.

## Caveats / still open
- The "green" full run used a stub kubectl — a real server dry-run needs the demo-plane cluster
  (section 1 applies `00-namespace.yaml` for real), which is not this machine's context and was
  not touched. Section-1 logic is unchanged in semantics, only in failure handling.
- **#797's wiring half remains open**: `_validate.sh` is still not wired into the root
  `.github/workflows` (the packages/scale-zero-pg/.github copy is subtree residue). The script is
  now safe to wire — it no longer lands red (baseline green) and its exit codes are CI-faithful.
