# Code review — PR #963 (metrics port 9091 → 9464, closes #951)

Branch `agent/s3-metrics-port`, base `agent/s2-tail`. Adversarial pass. **Verdict: ISSUES_FOUND (4).**

---

## F1 — HIGH. `kn-next doctor` reads a Knative ConfigMap key that no longer exists in the Knative the operator itself vendors, and the absent-key default is inverted there

`packages/kn-next/src/cli/doctor.ts:1224-1227`

```ts
const backend = data["metrics.request-metrics-backend-destination"] ?? "prometheus (Knative default — key unset)";
const userMetricsActive = data["metrics.request-metrics-backend-destination"] !== "none";
```

The premise ("absent key = prometheus = queue-proxy binds :9091") is true only for the *legacy*
observability config. It was verified against the version this repo depends on and it does **not**
hold:

- `packages/kn-next-operator/go.mod:20-21` pins `knative.dev/pkg v0.0.0-20260120122510` and
  `knative.dev/serving v0.48.0`.
- In that tree the string `metrics.request-metrics-backend-destination` **does not appear at all**
  (grep over both modules: zero hits). The OTel migration replaced it.
- Queue-proxy's user-metrics listener is now driven by `request-metrics-protocol`:
  `serving@v0.48.0/pkg/observability/config.go:115` → `metrics.NewFromMapWithPrefix("request-", m)`
  → `pkg/observability/metrics/config.go:82` (`configmap.As(prefix+"metrics-protocol", …)`).
- The default when the key is absent is **`ProtocolNone`**, not prometheus:
  `pkg/observability/metrics/config.go:65-69` (`DefaultConfig()` → `Protocol: ProtocolNone`),
  wired in at `serving/pkg/observability/config.go:100` (`RequestMetrics: metrics.DefaultConfig()`).
- `:9091` is bound only when protocol == prometheus:
  `serving@v0.48.0/pkg/queue/sharedmain/otel.go:51-54`.

Concrete failures on any cluster at/after the OTel migration (i.e. the one the operator compiles
against):

1. **False red.** Stock cluster, protocol defaults to `none`, nothing binds `:9091`. A NextApp that
   pins `spec.env.METRICS_PORT=9091` → `doctor.ts:1283` pushes `fail` and `report.exitCode` is 1,
   asserting "queue-proxy binds :9091 for its user-metrics server on this cluster
   (request-metrics-backend-destination=prometheus (Knative default — key unset))". Neither clause
   was measured; both are false there.
2. **Unmeasured claim on the pass path.** `doctor.ts:1299-1300` prints "queue-proxy owns :9091 on
   this cluster" on every modern cluster, and also on a cluster with **no Knative at all** —
   `infraFailure` (`doctor.ts:237-240`) classifies only network/auth/forbidden, so a `NotFound`
   ConfigMap falls through to `data = {}` and is read as "prometheus active".
3. This folds an unmeasurable condition into a definite verdict, which is exactly what the sibling
   `netpol` check 30 lines below refuses to do ("fails honest: 'cannot determine' is a distinct
   outcome from 'enforced', never folded into it", `doctor.ts` comment (i)).

**Fix:** read both keys (`metrics.request-metrics-backend-destination` and
`request-metrics-protocol`); an explicit `none` on either wins; when **neither** key is present,
the answer is version-dependent — report it as such (warn / "cannot determine which observability
schema this Serving uses") instead of asserting prometheus.

---

## F2 — MEDIUM. The doctor check matches the literal `9091` only, and is blind to the upgrade-skew window it exists for

`packages/kn-next/src/cli/doctor.ts:1274`

```ts
.filter((i) => (i.spec?.env?.METRICS_PORT ?? "").trim() === "9091")
```

- `metrics-port-lockstep.test.ts` already owns the real answer —
  `QUEUE_PROXY_OWNED_PORTS = {8012, 8013, 8022, 8112, 9090, 9091}` — and the doctor does not reuse
  it. An app pinning `METRICS_PORT=9090` (queue-proxy's autoscaling-metrics port, bound
  unconditionally) crash-loops identically and doctor reports `pass`. Same for 8012/8013/8022/8112.
- **The skew case is a false green.** The changeset (`.changeset/metrics-port-9464.md:13-16`)
  correctly warns operator-first/CLI-second (#548). During that window a NextApp running a
  pre-#951 runtime image defaults to 9091 with **no** `METRICS_PORT` env, so the filter misses it
  and `doctor.ts:1301-1302` affirmatively states "knext apps default their metrics listener to
  :9464 and no NextApp overrides METRICS_PORT onto 9091". That is the one situation this check was
  added to catch, and it reports healthy.

---

## F3 — MEDIUM. Doc sweep missed the security audit of the object this PR changed

`docs/security/mutating-endpoints.md:59, 63, 67` still documents all three ingress rules with the
old port:

- rule 1 "Serving + metrics ports (`8012`, `8013`, `8112`, `9090`, `9091`)"
- rule 2 "Metrics ports only (`9090`, `9091`)"
- rule 3 "The app metrics port only (`9091`)"

This is the standing audit cited by `.claude/rules/security.md` and `CLAUDE.md §7` for the
operator-reconciled NetworkPolicy — the exact object `desiredIngressRules()` just moved to 9464.
The PR updated `docs/security/threat-model.md` but not this file.

Also stale, and describing current runtime rather than history:

- `docs/ARCHITECTURE.md:413` — "process boot + code-cache deserialize + `:9091` metrics up" in the
  live cold-start sequence diagram.
- `docs/operator/postgres-scale-to-zero.md:320` — "also exported on the runtime `:9091` registry as
  `knext_deep_health_state{…}`".

(`docs/adr/0044-*.md`, `0036`, benchmark ledgers and `.claude/` reports are legitimately historical
— no change wanted there.)

---

## F4 — LOW. The lockstep guard enumerates five paths; the one copy that can drift silently is the hash-pinned one

`packages/kn-next/src/__tests__/metrics-port-lockstep.test.ts:39-90` hardcodes four file paths (five
surfaces). Two consequences:

- A **sixth kind** of surface — a new operator YAML with a `targetPort`, a dashboard panel port, a
  second PodMonitor — is not discovered. Contrast `scripts/lib/runtime-entry-copies.mjs`, which is
  explicitly a scan-by-basename "because enumeration is how the fourth copy gets missed".
- Entry copies *are* transitively covered by that scan (all five checked-in copies verified at
  `9464`), **except** `examples/bun-exec/knext-bun-entry.mjs`, which is `DIVERGENT` and therefore
  hash-pinned rather than byte-compared. Editing that copy's port and re-pinning the hash passes
  both guards. It is the one entry actually compiled into the shipped example binary.
- `QUEUE_PROXY_OWNED_PORTS` is a hardcoded set; it drifts if Knative adds a sidecar listener. The
  operator can derive from `knativenetworking`; a TS test cannot. Acceptable, but it means the
  "not queue-proxy-owned" assertion is documentation-grade, not derived.

---

## Verified sound (attacked, held)

- **Extract-and-compare is real.** All five surfaces are parsed out of the actual files by regex and
  the extractors **throw** rather than skip when an anchor is missing, so the guard cannot no-op
  after a refactor. The self-test resolving the old
  `int32(knativenetworking.UserQueueMetricsPort)` alias to `9091` (rather than throwing) is the
  right call — the collision assertion reports the real defect instead of an extraction failure.
- **`appMetricsPort = int32(9464)` as a literal with the why-not-the-constant comment**
  (`nextapp_controller.go:1376-1387`) is correct: `knativenetworking.UserQueueMetricsPort == 9091`
  (`serving@v0.48.0/pkg/networking/constants.go:42`). The old alias *was* the bug.
- **All five entry copies at `9464`**; the `DIVERGENT` reason
  (`scripts/lib/runtime-entry-copies.mjs:84-107`) is honest and correctly scoped — it records only
  the image intercept and explains why the hash moved, twice, without widening the exemption.
- **#957 overlap is genuinely trivial.** `git merge-tree --write-tree origin/agent/s3-metrics-port
  origin/pr957` merges clean (tree `55079a5c…`, no conflicts). Overlap is
  `runtime-contract.mjs`×5, `scripts/lib/runtime-entry-copies.mjs`, `docs/PUBLIC_API.md`, two
  `vite.config.ts` — disjoint hunks, and #957 touches `runtime-contract.mjs` while the DIVERGENT
  pin is on `knext-bun-entry.mjs`. The PR's claim is accurate.
- **NetworkPolicy change is port-number-only** — same three rules, same From peers, no new grants.
  Matches the PR's security-trigger note. One consequence the note omits: the same-namespace rule no
  longer admits `9091`, so a co-resident Prometheus scraping **queue-proxy's own** user metrics is
  now denied on an enforcing CNI. Nothing knext ships queries those series (no `revision_*` /
  `activator_*` in `config/observability/prometheusrule.yaml` or the dashboards), so it is cosmetic
   — but it belongs in the note.
- Changeset's #548 upgrade-order caveat is accurate and correctly scoped.

## Nits (non-blocking)

- Nothing at boot names the failure mode. `templates/app/knext-bun-entry.mjs.hbs:250-281` starts the
  metrics `Bun.serve` unguarded, so an override collision still surfaces as a bare Bun bind error.
  A `try/catch` naming `METRICS_PORT`/queue-proxy would close the loop the doctor hint opens.
- `packages/kn-next-operator/internal/controller/networkpolicy_test.go:127` (touched by this diff)
  cites `nextapp_controller.go:820`; the annotation site is now `:851`.
- The "operator `make test` — 109 specs" claim was not independently re-run in this review.
