# knext × scale-zero-pg — end-to-end demo (issue #8)

The north star of this project, running: a real **knext `NextApp`** (Knative
scale-to-zero) bound to the **scale-to-zero Postgres** platform, on the same
cluster. Both sleep at rest; **one cold HTTP request wakes both** and returns
data from Postgres; then both idle back to zero.

```
 visitor ──HTTP──▶ Kourier ──▶ [ pg-demo NextApp ]  ──DATABASE_URL──▶ [ pggw gateway ] ──▶ [ Neon compute ]
                   (Knative)     Knative Serving          Secret        scale-zero-pg      replicas 0↔1
                                 scale 0↔N                              (wake-on-connect)
        both at 0 when idle ▲───────────────┘                                  └────────── wakes on first connection
```

The **only** wiring between the app and the database is a `DATABASE_URL` Secret
pointing at the gateway Service — the entire knext integration contract
(`docs/connecting.md`).

## What's here

| Path | What |
|---|---|
| `app/` | A minimal Next.js app (`output: 'standalone'`). One page: `INSERT` a visit + `SELECT now(), count(*)`. Health at `/api/health` (never touches the DB). |
| `app/lib/db.js` | pg pool mirroring `@knext/lib` `getDbPool` — max 5, **idle 10s < gateway's 60s** idle window. |
| `manifests/00-namespace.yaml` | `knext-demo` namespace (the app's own ns; separate from the DB platform). |
| `manifests/10-database-secret.yaml` | The `DATABASE_URL` Secret → `pggw.scale-zero-pg.svc:55432`. |
| `manifests/20-nextapp.yaml` | The `NextApp` CR. `minScale: 0` (app scales to zero). Injects `DATABASE_URL` via `spec.secrets.envMap`. |
| `operator/kn-next-operator-install.yaml` | Vendored kn-next operator install bundle (provenance header inside). |
| `manifests/30-demo-canary.yaml` | Optional synthetic canary (issue #39): a `CronJob` in the `scale-zero-pg` ns that probes the app cold every 15 min; a failed run trips `DemoCanaryFailed`. See operations.md → [demo-canary](../docs/operations.md#demo-canary). |
| `_verify.sh` | The measured drill (below). Joins the test battery. |

## Prerequisites (already true on `knext2` / context `context-ckmva7v7zvq`)

- Knative Serving + Kourier (`ingress-class: kourier.ingress.networking.knative.dev`).
- The scale-zero-pg platform in the `scale-zero-pg` namespace (the gateway `pggw`).
- **cert-manager** (the operator's validating webhook needs a serving cert):
  ```
  kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
  ```

## Reproduce

```sh
# 1. Install the kn-next operator (namespace kn-next-operator-system).
kubectl apply --server-side -f demo/operator/kn-next-operator-install.yaml
kubectl -n kn-next-operator-system rollout status deploy/kn-next-operator-controller-manager

# 2. (Only if building your own image) build the demo app for amd64 and push.
#    OKE nodes are amd64; the operator webhook requires a DIGEST-pinned ref.
docker buildx build --platform linux/amd64 \
  -t me-abudhabi-1.ocir.io/axfqznklsd2t/pg-demo:v1 --push demo/app

# 3. Deploy the app: namespace, DATABASE_URL secret, NextApp CR.
kubectl apply -f demo/manifests/00-namespace.yaml \
               -f demo/manifests/10-database-secret.yaml \
               -f demo/manifests/20-nextapp.yaml
kubectl -n knext-demo get ksvc pg-demo   # wait for READY=True

# 4. Run the measured drill (creates + cleans up its own helper pods).
ITERS=5 bash demo/_verify.sh

# 5. (Optional) wire the app up as a scheduled synthetic canary (issue #39).
#    A failed cold wake then trips DemoCanaryFailed via the existing alert plane.
kubectl apply -f demo/manifests/30-demo-canary.yaml
```

The app URL is `http://pg-demo.knext-demo.<LB-IP>.sslip.io`. Host `curl` isn't
needed — `_verify.sh` drives HTTP from a pod inside the cluster, and it **derives
the Host header at runtime** from the ksvc's own `.status.url` (issue #40), so it
reproduces on any cluster with no hardcoded LB IP. Override with
`KSVC_HOST=... bash demo/_verify.sh` if you route through a custom domain.

## The measurement

`_verify.sh` proves the loop N times and separates three request classes so the
DB-wake cost is isolated from the app's own Knative cold start:

| Class | Setup | What it measures |
|---|---|---|
| `T_both` | both asleep | the headline: one request wakes **app + DB** |
| `T_appcold` | DB pre-woken (psql), app asleep | app cold start alone |
| `T_warm` | both awake | steady state |
| bare DB cold-connect | psql through `pggw`, no app | DB wake as a bare client sees it |

`combined-cold overhead = T_both − T_appcold` — this is the extra cost of waking
**both** at once (co-scheduling / image-cache-locality contention in the
both-cold path), **not** the DB wake: it routinely exceeds the bare DB
cold-connect (~2.6s), so it cannot be attributed to the database (issue #45).
Numbers and analysis: `docs/BENCHMARKS.md` → *Combined wake (knext demo)*.

## Findings fed back to the platform

See `docs/BENCHMARKS.md` and the PR for issue #8. Notable operational finding
during bring-up: on this cluster the kn-next operator bundle's
`config-network` pins `ingress-class: kourier.knative.dev`, but the installed
net-kourier reconciler serves `kourier.ingress.networking.knative.dev` — new
KIngresses were skipped until the `KnativeServing` CR's ingress-class was
aligned. Filed as a knext-side finding.

## Cleanup

```sh
kubectl delete -f demo/manifests/30-demo-canary.yaml --ignore-not-found  # if the canary was enabled
kubectl delete -f demo/manifests/20-nextapp.yaml -f demo/manifests/10-database-secret.yaml
kubectl delete ns knext-demo
kubectl delete -f demo/operator/kn-next-operator-install.yaml   # removes the operator
```

Delete the canary **with** the app — left running without `pg-demo` it will
correctly page that the wake path is broken.
