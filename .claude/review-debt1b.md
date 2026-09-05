# Review verdict — validator aggregate + fsGroup fix (#797/#793), branch fix/validate-aggregate

**Verdict: ISSUES_FOUND — one demonstrated guard hole (contract 31 scan is one-directional).
Everything else survived every attack.** Independent harness (not the implementer's):
scratchpad `rev-harness.sh`, stub kubectl (no cluster touched), exit-code-branching only,
anchors count-asserted, worktree git-restored and verified diff-clean after.

## Attack results

### (1) Aggregation — CONFIRMED
- Baseline all-clean: **exit 0**, "all checks passed".
- Early file (`20-compute.yaml` replicas 0→1, contract 2) **and** late file
  (`82-appdb-crd.yaml` warmSchedule removed, contract 32 — the last) broken in ONE run:
  **exit 1, BOTH reported, summary `2 FAILURE(S)`**. Restored → exit 0 again.
- No-kubectl run: exit 1, exactly one recorded failure, **all 38 contract-block lines still
  evaluated**.

### (2) set -e semantics / tripwire — CONFIRMED
- Bare `false` injected mid-script (after the trap): run continues, clean contracts → exit 0.
  A command failing inside a check cannot abort the loop.
- Stray `exit 0` injected before contract 12: **rc=70** + loud early-death message.
- `set -eu` reintroduced + a failing command: **rc=70**, not a vacuous pass. (First attempt got
  rc=1 — my harness had injected before the trap was installed; correct placement gives 70.)

### (3) fsGroup fix — CONFIRMED
Dup-key-rejecting SafeLoader: branch `60-prometheus.yaml` strict-parses clean (7 docs);
`origin/main` is **rejected** (`duplicate keys {'fsGroup'}` line 663) and plain `safe_load`
silently accepts it (why it hid). The Prometheus Deployment pod securityContext parses to
exactly the intent: `{runAsNonRoot: true, runAsUser/runAsGroup/fsGroup: 65534,
seccompProfile: RuntimeDefault}` — fsGroup kept once, not dropped.

### (4) Exit codes CI-faithful — CONFIRMED, with a fact-check
0 = all pass, 1 = ≥1 contract failure, 70 = premature abort — all failures non-zero.
**No CI lane consumes the script today**: root `.github/workflows/scale-zero-pg.yml` exists but
runs only `turbo build lint test build:image`, and no package script invokes `_validate.sh`.
The impl report's "wiring half remains open" claim is accurate in substance; the script is now
safe to wire.

### (5) Check weakening — one hole found, one re-pin verified sound
- Contract 19 anchor re-pin: the new anchor matches the live rule
  (`60-prometheus.yaml:162` `min_over_time((sum(pggw_active_connections) - (sum(appdb_warm_hold_active) or vector(0)))[30m:1m])`);
  state-based-ness + subtraction still asserted, contract 32 covers `or vector(0)`. Not weakened.
- Contract 31 scoping from whole-file to `grep -A3 'pg-base-admin'` is *justified* (the
  `compute-jwt-trust` refs in 20/25/26 are genuinely `optional: true` by design, flow-style),
  **BUT the window only looks AFTER the anchor**:

## FINDING (must fix before wiring into CI)

**`optional: true` placed *above* `name: pg-base-admin` inside the same secretKeyRef escapes
the guard — demonstrated: injected it into `20-compute.yaml`, run exits 0.** YAML mapping key
order is author-controlled, so the fail-closed invariant is enforceable in only one key order.
Injected below the name line it is caught (exit 1), and flow-style single-line refs are caught.
Fix is one token: `grep -B3 -A3 'pg-base-admin' "$m" | grep -Eq 'optional:[[:space:]]*true'`
(mutation-prove both directions after).

## Hygiene
Worktree diff-clean after all mutations (`git status --porcelain` empty). No cluster contacted
(stub kubectl on PATH for every run).

# Round 2 — APPROVE

The contract-31 finding is fixed at head `98f84c2` exactly as specified: `grep -B3 -A3
'pg-base-admin'` with the comment updated to state the reason (author-controlled YAML key
order). Independently re-verified with my own harness (stub kubectl, exit-code branching,
git-restore between runs):

- **Both directions, all three manifests**: `optional: true` injected *above* and *below* the
  `name: pg-base-admin` line in each of `20-compute.yaml`, `25-compute-warm.yaml`,
  `26-compute-ro.yaml` → **exit 1 in all six runs**, with the contract-31 failure message.
- **No false positive from the widened window**: zero `optional:[[:space:]]*true` lines fall
  within ±3 of any `pg-base-admin` line in the three manifests — the deliberately-optional
  `compute-jwt-trust` refs stay out of the window — and the **all-clean baseline exits 0**,
  restored-clean exits 0.
- Worktree diff-clean after all mutations; no cluster contacted.

No remaining findings. **APPROVE.**
