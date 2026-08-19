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
  `APPDB_GATEWAY_HOST`, default `pggw-apps.scale-zero-pg.svc`). A
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

**Teardown.** Delete the CR (`kubectl -n scale-zero-pg delete appdatabase ${APP}`);
the deprovision finalizer runs the timeline reclaim. A `1` left on
`appdb_warm_hold_active` for a deleted or cold app is a leak — report it, do not
re-run over it.

## See also

- [`appdatabase-api.md`](../appdatabase-api.md) §2a (what `warm` actually is), §3b
  (scheduled windows), the `WarmHold` condition contract in §2.
- [`operations.md`](../operations.md) — the `WarmHoldDegraded` runbook bullet and the
  `ComputePhantomKeepalive` subtraction.
- [`DRILLS.md`](../DRILLS.md) — the scripted battery this drill should eventually join.
