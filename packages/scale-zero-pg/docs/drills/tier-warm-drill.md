# Drill — `AppDatabase spec.tier: warm` is a permanent warm hold (#777)

**What it proves.** `tier: warm` keeps the app's compute awake **past the gateway idle
window** via one permanently-held authenticated gateway connection — not a replica
floor — and withdrawing warmth releases that hold within one resync tick. This is the
running-system half of #777/#778; the unit tests
(`gateway/internal/appdb/tier_warm_test.go`) pin the reconcile behaviour only.

**Status: manual (turnkey steps below), not yet scripted into the battery.** The
follow-up is a `deploy/_verify-tier-warm.sh` alongside `_verify-warmtier.sh` (which
covers the *separate* single-DB gated-pod warm tier, not `AppDatabase spec.tier`).
Until then, this doc is the drill of record — run it top to bottom; every assertion
is a command with an expected value.

**Preconditions.**
- The appdb operator image is built from a post-#777 revision and **deployed**
  (`kubectl -n scale-zero-pg get deploy appdb-operator -o jsonpath='{.spec.template.spec.containers[0].image}'`
  — confirm the tag/digest before attributing behaviour to code you read; merged ≠ deployed).
- The shipped operator binary always wires the warm-hold actuator (its dial target is
  `APPDB_GATEWAY_HOST`, default `pggw-apps.scale-zero-pg.svc.cluster.local.` — rooted). A
  `WarmHold=False/HoldsUnavailable` therefore means you are running an operator build
  without the actuator compiled in (an embedder build) — not a missing env var; stop
  and fix the deployment before drilling.
- Know the plane's idle window: `GW_IDLE_MS` (deployed: 60000) and the operator resync
  tick `APPDB_RESYNC_MS` (default 15000). The wait in step 3 must exceed
  `GW_IDLE_MS + APPDB_RESYNC_MS`.
- Cluster work is a queue of one: nothing else may be driving traffic at the app under
  test, or the "stays warm" observation is confounded by ordinary keep-alive.

## 1. Warm half — the hold survives the idle window

```sh
APP=drill-tierwarm
kubectl -n scale-zero-pg apply -f - <<EOF
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata: { name: ${APP}, namespace: scale-zero-pg }
spec: { appName: ${APP}, tier: warm }
EOF
kubectl -n scale-zero-pg wait appdatabase/${APP} --for=condition=Ready --timeout=180s
```

Connect once through the apps gateway and close the session (any `psql -c 'select 1'`
against the `DATABASE_URL` in the output Secret `app-db-${APP}`), then wait
**longer than `GW_IDLE_MS` plus one resync tick** (deployed plane: ≥ 90s).

Assert, in order:

```sh
# (a) the compute did NOT park — pre-#777 this is where it degraded to 0 forever
kubectl -n scale-zero-pg get deploy compute-${APP} \
  -o jsonpath='{.status.readyReplicas}'          # expect: 1

# (b) status says warm, for the tier reason, and Ready carries the warm-held reason
kubectl -n scale-zero-pg get appdatabase ${APP} -o json \
  | jq '[.status.conditions[] | select(.type=="WarmHold" or .type=="Ready")
         | {type, status, reason}]'
# expect: WarmHold True/TierWarm, Ready True/WarmHeld

# (c) the mechanism is visible: exactly one deliberate hold declared for this app
#     (operator metrics on :9092/metrics)
kubectl -n scale-zero-pg exec deploy/appdb-operator -- \
  sh -c 'exec 3<>/dev/tcp/127.0.0.1/9092; printf "GET /metrics HTTP/1.0\r\n\r\n" >&3; cat <&3' \
  | grep "appdb_warm_hold_active{app=\"${APP}\"}"   # expect value: 1
```

## 2. Negative half — a failed hold degrades, never gates serving

Make the hold fail **without breaking serving**. Two constraints shape the method:

- Do NOT scale the apps gateway to 0: `psql` reaches the app *through* that gateway,
  so killing it fails the hold and serving together and the degrade-not-fail
  assertion below becomes unfalsifiable.
- Do NOT reach for `APPDB_GATEWAY_HOST` on the operator for an **existing** app: the
  hold dials the DSN stored in the app's Secret (`app-db-<app>` `DATABASE_URL`),
  which is minted **once** — the env var only shapes DSNs for newly minted apps, so
  an env edit is inert here and reads as "the degradation path is broken" when it is
  the method that is broken.

The method that works: **patch the drill app's own `DATABASE_URL` to an unreachable
host** (rewrite the host portion only; the operator never rewrites that key), then
**restart the operator** — a live hold is healthy TCP and is not redialled, but an
operator restart drops all holds (crash-only) and the redial uses the patched DSN.
Serving stays independently assertable with the Secret's separate `PGUSER`/`PGPASSWORD`
keys against the real gateway host. Assert:

- `WarmHold` goes `False/HoldFailed` and a `WarmHoldFailed` Warning event is emitted;
- `Ready` stays `True` with reason `WarmHoldDegraded` — warmth is lost, serving is not;
- a fresh `psql` still works via the ordinary cold wake.

Restore the Secret's `DATABASE_URL`; within one resync tick the hold re-establishes
(`WarmHold` back to `True/TierWarm`, gauge back to `1`) — crash-only, self-healing.

## 3. Release half — withdrawing warmth releases the hold (the #786-round leak)

This is the assertion the fix round added: a hold must never outlive the spec that
asked for it. Pre-fix, editing `tier: warm → cold` leaked the hold forever — the
compute could never sleep again *and* the stale `appdb_warm_hold_active` subtraction
blinded the `ComputePhantomKeepalive` alert.

```sh
kubectl -n scale-zero-pg patch appdatabase ${APP} --type=merge \
  -p '{"spec":{"tier":"cold"}}'
sleep 20   # > APPDB_RESYNC_MS

# (a) the hold is gone and the condition is retracted, not left stale-True
kubectl -n scale-zero-pg get appdatabase ${APP} -o json \
  | jq '.status.conditions[] | select(.type=="WarmHold") | {status, reason}'
# expect: False/WarmthNotRequested

# (b) the gauge dropped with it — the alert subtraction cannot be blinded.
#     The exporter emits appdb_warm_hold_active ONLY for held apps, so on release
#     the series is ABSENT (the alert's PromQL carries `or vector(0)` for this).
#     Same /metrics read as 1(c) — expect: NO appdb_warm_hold_active{app="${APP}"}
#     line at all. (grep exiting 1 here is the pass; a `1` line is the leak.)

# (c) the compute now parks on the ordinary idle window: wait > GW_IDLE_MS and
kubectl -n scale-zero-pg get deploy compute-${APP} \
  -o jsonpath='{.spec.replicas}'                 # expect: 0
```

## 4. Rotation half — a warm app's hold across `rotate-cred` (#798)

**What it proves.** The sanctioned sequence for rotating a **warm** app's credential is
`rotate-cred <app> --bounce`, and the hold re-dials on the rotated DSN afterwards. The
unit halves are in `gateway/internal/appdb/warmhold_rotation_test.go` (a healthy hold is
not re-dialled on a Secret change; a dead hold re-reads the Secret and dials the new
credential; a re-dial the old verifier rejects errors out and drops the app from
`Held()`), all against fakes — this step is the running-system half.

This step needs the app **still warm**, so run it before §3 — or, if you already ran §3,
re-apply `tier: warm` and wait one resync tick first. The drill's queue-of-one rule
applies: nothing else may be driving traffic at the app, or "it stayed warm" is
confounded by ordinary keep-alive.

```sh
cd deploy

# (a) baseline: the app is held right now (same /metrics read as 1(c))
kubectl -n scale-zero-pg exec deploy/appdb-operator -- \
  sh -c 'exec 3<>/dev/tcp/127.0.0.1/9092; printf "GET /metrics HTTP/1.0\r\n\r\n" >&3; cat <&3' \
  | grep "appdb_warm_hold_active{app=\"${APP}\"}"
# expect: ... 1

# (b) rotate WITHOUT --bounce: the live hold is undisturbed, on the OLD credential.
#     The Secret already carries the new one — the divergence is the point.
./provision-app.sh rotate-cred ${APP}
sleep 20   # > APPDB_RESYNC_MS: at least one reconcile pass has seen the new Secret
kubectl -n scale-zero-pg exec deploy/appdb-operator -- \
  sh -c 'exec 3<>/dev/tcp/127.0.0.1/9092; printf "GET /metrics HTTP/1.0\r\n\r\n" >&3; cat <&3' \
  | grep "appdb_warm_hold_active{app=\"${APP}\"}"
# expect: STILL 1 — a healthy hold is never re-dialled just because the Secret moved
kubectl -n scale-zero-pg get appdatabase ${APP} -o json \
  | jq '.status.conditions[] | select(.type=="WarmHold") | {status, reason}'
# expect: True/TierWarm (unchanged)

# (c) the sanctioned sequence: --bounce lands the new verifier AND kills the hold, so
#     the next resync re-dials with a matching credential.
./provision-app.sh rotate-cred ${APP} --bounce
sleep 20
kubectl -n scale-zero-pg exec deploy/appdb-operator -- \
  sh -c 'exec 3<>/dev/tcp/127.0.0.1/9092; printf "GET /metrics HTTP/1.0\r\n\r\n" >&3; cat <&3' \
  | grep "appdb_warm_hold_active{app=\"${APP}\"}"
# expect: 1 again (re-established on the rotated DSN)
kubectl -n scale-zero-pg get deploy compute-${APP} -o jsonpath='{.spec.replicas}'
# expect: 1 — the app never left the warm set for longer than one resync tick
```

**A `0`/absent gauge that does not recover in (c)** is the failure this drill exists to
catch: the re-dial is being rejected. Read the operator log for the app — a `28P01`
password-authentication rejection means the compute is still enforcing the pre-rotation
verifier, so the bounce did not land (check `kubectl -n scale-zero-pg rollout status
deploy/compute-${APP}`); anything else is a genuine hold failure and belongs in the
`WarmHoldDegraded` runbook.

**Custom-zone planes:** export the same `APPDB_GATEWAY_HOST` the operator runs with
before invoking `provision-app.sh` by hand. The script honours it with the operator's
precedence (set → verbatim, unset/empty → the rooted default), which is what stops a
rotation from rewriting a working DSN to an unresolvable host (#798) — but the script
reads it from *your* environment, not from the operator Deployment.

## 5. Fleet pressure — worth measuring when more than a handful of apps go warm

Warm holds spend the apps-gateway's **process-wide** `GW_MAX_CONNS` budget (90 per
gateway pod, shared with all tenant client traffic — see `appdatabase-api.md` §2a's
capacity note). Each warm app is one permanent slot; exhaustion is refused `53300`
to **other apps' clients**. When drilling a plane that runs N warm apps, record
`pggw_rejected_connections_total` on the apps-gateway before and after, alongside
the warm-app count — a rise here that tracks warm-app growth is the capacity wall,
and it will show up on unrelated tenants first.

**You are not the only watcher.** `WarmHoldBudgetPressure` (deploy/60-prometheus.yaml,
warning) pages *before* that wall: `sum(appdb_warm_hold_active) > 0.5 * 90` — half of a
**single gateway pod's** `GW_MAX_CONNS` budget standing in declared holds (`tier: warm`
plus any active `warmSchedule` window) — sustained 15m. Note what that threshold is
**not**: with `replicas: 2` the fleet budget is `replicas × 90` = 180, so 45 holds is
~25% of it. The alert is a deliberately conservative, replica-independent tripwire and
will page early on a larger fleet; that is the trade for an expr that cannot go blind
(a `kube_deployment_spec_replicas` join would silence itself whenever kube-state-metrics
is absent — #792). Its threshold is a hand-copied fraction of `GW_MAX_CONNS`, so a drill
that changes that knob must change the alert too (both files say so;
`tests/warm-hold-budget-alert.test.ts` reds if they drift). What to do when it fires is
[operations.md → Warm-hold budget pressure](../operations.md#warm-hold-budget-pressure-knext-787).
Note the asymmetry with §3: this alert carries **no** `or vector(0)`, because an absent
gauge means zero warm holds and must not page — only `ComputePhantomKeepalive`, which
*subtracts* the gauge, needs the fallback.

**Teardown.** Delete the CR (`kubectl -n scale-zero-pg delete appdatabase ${APP}`);
the deprovision finalizer runs the timeline reclaim. A `1` left on
`appdb_warm_hold_active` for a deleted or cold app is a leak — report it, do not
re-run over it.

## See also

- [`appdatabase-api.md`](../appdatabase-api.md) §2a (what `warm` actually is), §3b
  (scheduled windows), the `WarmHold` condition contract in §2.
- [`operations.md`](../operations.md) — the `WarmHoldDegraded` runbook bullet, the
  `ComputePhantomKeepalive` subtraction, and the
  [`WarmHoldBudgetPressure`](../operations.md#warm-hold-budget-pressure-knext-787)
  fleet-capacity runbook (§5 above).
- [`DRILLS.md`](../DRILLS.md) — the scripted battery this drill should eventually join.
