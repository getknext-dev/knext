# Spec review — PR #963 vs issue #951 (metrics port 9091 → 9464)

**Verdict: ISSUES_FOUND** (1 blocker, 4 doc-drift, 2 honesty/scope notes)

## AC scorecard

| AC | Status | Evidence |
|---|---|---|
| AC1 boots on stock Knative | **Partially met — blocked by B1** | Default moved everywhere in the entry/operator path, but `examples/bun-exec/Dockerfile` pins `METRICS_PORT=9091`, so the one image CI builds and boots still collides. Live verification honestly deferred to the lead's cluster stage. |
| AC2 annotation / NP grant / bind port cannot silently disagree | **Met for 5 surfaces, gap on a 6th** | `metrics-port-lockstep.test.ts` extracts node-server, canonical entry template, `prometheus.io/port`, `appMetricsPort`, PodMonitor; asserts set-size 1 AND non-membership in `{8012,8013,8022,8112,9090,9091}`; extractor resolves the old `UserQueueMetricsPort` alias to 9091 so the collision assertion fires instead of the extractor throwing. Loud-fail on missed extraction. **Not covered: container `ENV METRICS_PORT` / `EXPOSE` in Dockerfiles.** |
| AC3 doctor detects | **Met for the override path; false-negative on the real-world path** | New `metrics-port` check + 4 hermetic tests (fail / pass-no-override / pass-backend=none / infra→ERROR per #230). Only inspects `spec.env.METRICS_PORT === "9091"`. |
| AC4 docs state it | **Met, with stale siblings** | `install.mdx` callout, `hardening.mdx` row, `observability.mdx` rationale. Four other docs left at 9091. |

## B1 — BLOCKER: `examples/bun-exec/Dockerfile` still forces the colliding port

```
examples/bun-exec/Dockerfile:47   METRICS_PORT=9091 \
examples/bun-exec/Dockerfile:50   EXPOSE 3000 9091
```
The entry now defaults to 9464, but the image `ENV` overrides it back onto queue-proxy's port. The file's own comment calls this "the one image CI actually builds and boots". On a stock Knative install this container is exactly the #951 crash-loop.

Corroborating: `examples/bun-exec/test/alpine-image.docker-e2e.test.ts:215` publishes `${metricsPort}:9464` — host maps to a container port nothing binds. The `.docker-e2e` suffix keeps it out of the default run, which is why "352/352 green" did not catch it. That divergence is precisely the AC2 failure mode ("cannot silently disagree"), so the fix should also **add the Dockerfile `ENV`/`EXPOSE` to the lockstep guard's surface list** — otherwise the sixth surface stays unguarded.

## Doc drift left at 9091 (all describe surfaces this PR changed)

1. `docs/security/threat-model.md` moved, but `docs/security/mutating-endpoints.md:59,63,67,78,118` — the **NetworkPolicy security audit** — still documents the three ingress rules as granting `9091`. Now factually wrong about the object this PR edits.
2. `docs/adr/0044-ingress-hardening.md:155,168,190-191` still states the app-metrics grant is `9091`. `CLAUDE.md` was amended; **the ADR that decided this allowlist was not**. Per `architecture.md` §3 this warrants an ADR-0044 amendment note, not just a root-doc edit.
3. `docs/operator/postgres-scale-to-zero.md:320` — `knext_deep_health_state` "exported on the runtime `:9091` registry". This is the *runtime* registry, not a scale-zero-pg listener; stale.
4. `packages/kn-next-operator/config/grafana/dashboards/scale-to-zero.json:171,212` — shipped panel descriptions still say "PodMonitor scrapes :9091 only". User-visible in the dashboards knext ships.

## Doctor false-negative (AC3 scope)

The check flags only `spec.env.METRICS_PORT === "9091"`. The population that actually hits #951 is **existing deployments running a pre-#951 runtime image with no override** — baked default 9091, no `spec.env`. For those the new doctor emits `pass` with the detail *"knext apps default their metrics listener to :9464"*, which is false for that image. Either widen the check (e.g. correlate crash-looping revisions / non-Ready NextApps while queue-proxy user-metrics is active) or, at minimum, soften the pass detail to scope the claim to post-#951 images.

## Port choice (9464) — justified

Rationale is recorded in three places (`observability.mdx`, `nextapp_controller.go:1371-1387`, the lockstep test header): conventional OTel Prometheus-exporter port, unclaimed by any queue-proxy listener; the exclusion set is enumerated and asserted. The alternative the issue names (documented+doctor-checked serving prerequisite) is implicitly rejected by AC1 ("without hand-editing serving's configmaps") — the PR satisfies the stronger option. No ADR was written; the reasoning is adequate at code-comment level given ADR-0044 already owns the surface, **but ADR-0044 should carry the amendment** (see drift #2).

## scale-zero-pg exemption — honest

`packages/scale-zero-pg/deploy/58-pswatcher.yaml`, `60-prometheus.yaml`, `25-compute-warm.yaml` bind/scrape `:9091` on plain Deployments/Services in their own namespace. No Knative Service, no queue-proxy sidecar, no shared netns. Exemption is correct.

## Changeset level + upgrade note

`minor` on `@getknext/core` at `0.3.1` → `0.4.0`. Under 0.x, minor **is** the breaking level and changesets cannot emit a major short of 1.0.0, so the level is correct and semver-honest. **What is missing is loudness and a migration note:**

- The changeset covers upgrade *order* (#548) but never says the change is **breaking for anyone scraping 9091 externally** — hand-rolled Prometheus scrape configs, Grafana datasource queries, firewall/NP rules outside the operator's, custom PodMonitors. Those go **silently dark** — the exact failure mode `metrics-port-lockstep.test.ts` exists to prevent, only across the version boundary where no guard reaches.
- Neither `apps/docs/content/docs/upgrading.mdx` (which has a "What this does not cover" section) nor `docs/runbooks/upgrade.md` §3 post-upgrade verification was touched. An existing operator points its PodMonitor at 9464 while an old app image still binds 9091 — and vice versa — for the whole skew window.

Ask: prefix the changeset with an explicit **BREAKING (default port)** line naming the external-scrape blast radius, and add a short "metrics port moved to 9464 — update any scrape config you own" step to `upgrading.mdx` + a verification line in the upgrade runbook.

## "Closes #951"

AC1 is a live-boot claim the PR explicitly does not make ("Live kind/OKE verification is the lead-owned pipeline stage; not claimed here"). `Closes #951` auto-closes on merge, ahead of that verification. Acceptable **only if** the lead's kind/OKE stage runs and passes before merge; otherwise downgrade to `Refs #951` and close on the verification. Flagging as sequencing, not dishonesty — the PR body is candid.
