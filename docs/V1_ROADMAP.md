# Roadmap to knext v1.0

> Planned 2026-07-26 by the architect and system-designer gates, synthesised here.
> Full working notes: the two planning documents produced alongside this one.
> Strategy: `CLAUDE.md`. Tiers: `ROADMAP.md`. Exit criteria style: `docs/MATURITY_PLAN.md`.

## The thesis

knext's **terminal** failure handling is genuinely good — honest `Ready`, a single
`computeStatusVerdict` path, finalizers, stall detection. Its **silent** failure handling is the
1.0 gap:

- a pruned CR field (§2.1),
- a webhook-down deploy freeze (§2.2),
- a torn cache write on SIGTERM (§2.3),
- a `NetworkPolicy` that is a no-op on someone else's cloud (§5),
- a cold-start mode nobody has looked at (§4).

**Every one of those reports success.** A 1.0 is a promise about behaviour under failure, and the
failures that block this 1.0 are the ones that currently return `Ready=True`.

---

## 1. What 1.0 commits us to

**Committed** (breaking change ⇒ major version):

- the public TypeScript surface of `@getknext/core`, `@getknext/lib`, `@getknext/db` per
  `docs/PUBLIC_API.md`;
- the `kn-next.config.ts` schema;
- the `kn-next` CLI verbs, flags and exit codes;
- **the shape of the `NextApp` CR the CLI emits** — this is observable behaviour of a 1.0 artifact,
  which is why the CRD version question below is not academic;
- the operator↔CLI compatibility contract, published and machine-checked.

**Explicitly not committed:** cold-start *latency* numbers (§4), the `bun-exec` build target
(ADR-0036, opt-in and unsupported), zones/PWA/MFE recipes, the gRPC `BackendService` module,
and anything upstream-gated (edge middleware, PPR/Cache Components).

### The open decision: CRD version at 1.0

The two planning gates disagreed, and this needs a human call.

| position | argument |
|---|---|
| **Graduate to `v1beta1` before 1.0** (architect) | `cr-builder.ts:364` hardcodes `apps.kn-next.dev/v1alpha1`. ADR-0017 permits breaking CRD changes *because* it is alpha; `PUBLIC_API.md` promises semver. Those coexist only while packages are 0.x — at 1.0 they contradict, because the emitted CR is 1.0 behaviour. ADR-0017's own revisit trigger ("after npm publish") **fired today**. |
| **Ship 1.0 on `v1alpha1` + an ADR** (system designer) | The actual harm is silent field loss, and the **prune preflight (P1-3) fixes that directly** without a conversion webhook. Graduating adds a webhook, cert wiring, storage migration and round-trip conversion coverage — the longest pole in the plan — to buy consistency rather than safety. |

**Recommendation:** ship 1.0 with the CRD at `v1alpha1`, *provided* the prune preflight lands and
an amended ADR-0017 states plainly that the CRD is versioned **separately** from the npm packages,
with its own alpha guarantee and a published graduation trigger. Graduate to `v1beta1` as the first
post-1.0 epic. The architect's contradiction is real but is a **documentation** problem once the
preflight removes the **safety** problem — and shipping a conversion webhook nobody has operated is
its own risk.

---

## 2. The failure modes that block 1.0

### 2.1 A CR applied against an older operator — the worst mode in the system
The CRD is structural and carries **no** `x-kubernetes-preserve-unknown-fields`, so an unknown field
is dropped rather than stored. Take a field the CLI really emits and that an older CRD plausibly
predates: a user on a newer `@getknext/core` who sets `spec.database.roSecretRef` against an older
operator would get apply **accepted**, field **silently dropped**, `NextApp` **`Ready=True`** — and
because `DATABASE_URL_RO` is then never injected, `getDbRO()` falls back to the writer pool
(`packages/db/src/index.ts`) and staleness-tolerant reads run on the read-**write** primary
credential. A least-privilege downgrade, reported as success.

**Corrected by measurement (live cluster, server-side dry-run against the structural CRD):** whether
the field is pruned depends entirely on the *validation mode of the apply*, not on the CRD:

- `kubectl apply --validate=strict` — the apiserver **REJECTS** the object:
  `Error from server (BadRequest): … strict decoding error: unknown field "spec.…"`.
- `kubectl apply --validate=ignore` — accepted, field pruned, no error.

`strict` has been kubectl's default since 1.25 (server-side field validation GA in 1.27), so the
common case was already protected — but only by **an external binary's default**. Two vectors take
that away, and only two: an **old kubectl** on PATH, or a **wrapper/shim binary named `kubectl`**
(asdf/krew/kubie shims, corporate wrappers) that passes `--validate=ignore`. A shell alias is *not*
one — the CLI spawns kubectl through `execFile` with `shell: false`, so no interactive alias is ever
in the path — and kubectl exposes no kubeconfig key or environment variable for `--validate`.

**Mitigation landed:** **every** `kubectl apply` the CLI issues now passes `--validate=strict`
explicitly — the prod CR apply (`deploy.ts`), the preview CR apply (`preview.ts`, the path CI runs
most often), and the k6 load-test Job (`loadtest.ts`) — so the guarantee is knext's, not the user's
kubectl's. A failed apply is rewrapped with a diagnosis that names a cause only when knext can
establish one (see the kubectl ≤ 1.24 residual) and otherwise offers a differential; `kn-next
doctor` reports when the local client is older than v1.25, where that flag value does not exist.
A generalised argv guard (`cr-apply-strict-validation.test.ts`) scans source rather than
enumerating call sites — enumerating is exactly how `preview.ts` was missed the first time. Its
scope is precise: the `*.ts` files **directly inside** `packages/kn-next/src/cli/` (top level, no
recursion), which is where all three applies live today; nothing outside that directory is checked.
Within it the guard is per-**site**, not per-file: every quoted `apply` verb must correspond to an
argv the scanner parsed and asserted, so a fourth apply site — including a second one in an
already-covered file, or one written in a construct the scanner cannot read — fails the suite
instead of slipping through.

**Residual, not closed:**

- **GitOps controllers — name them, because "programmatic client" understates this.** Argo CD's
  apply and Flux's kustomize-controller server-side apply do **not** assert strict field validation
  by default, so a GitOps-managed `NextApp` is still prunable. That is the mainstream production
  path, not an edge case. (`kubectl apply --server-side` and `kubectl replace` *are* covered — both
  set `fieldValidation=Strict` from kubectl 1.25.)
- **kubectl ≤ 1.24 users** fail at flag parsing rather than being protected — `--validate` is a
  boolean before 1.25, so `deploy` errors before contacting the apiserver. This is a **behaviour
  change**: deploys that previously succeeded on kubectl ≤ 1.24 now hard-fail. Fail-closed is the
  right call (1.24 is long EOL); it is surfaced by `doctor`, and on a failed apply `deploy` probes
  the local client so it reports *the client is too old* rather than blaming the CRD.
- **A `kubectl` shim on PATH still wins.** pflag takes the **last** occurrence of a string flag, so a
  wrapper appending `--validate=ignore` overrides knext's argv, and `exec.ts` hardcodes the binary
  name with no path/digest pinning. The flag guarantees knext's own argv, not the binary that
  receives it.
- `doctor` still checks only that the CRD *exists*, not that its schema covers every field this CLI
  emits — the schema-diff preflight (#314) remains the complete fix.

Not a gap: an apiserver too old for server-side field validation. kubectl ≥ 1.25 falls back to
client-side OpenAPI schema validation, which still catches an unknown CRD field.

**Upgrade ordering is now load-bearing and undocumented.** Strict validation makes a
newer-CLI-against-older-CRD apply fail loudly instead of silently dropping the field, so the
required order is **operator/CRD first, then CLI**. knext documents no ordering anywhere today
(`db-bind` merely assumes it in an error string). This PR does not create the skew — it makes it
visible — but the ordering belongs in the release-channel doc (ADR-0020) as one sentence.

### 2.2 Operator upgrade while CRs exist
`config/webhook/manifests.yaml` sets `failurePolicy: Fail` on a webhook served by the operator
itself, with no `namespaceSelector`. While the operator is unavailable, **every `NextApp`
create/update is rejected cluster-wide**. Fail-closed is the right default, but it puts the operator
roll on the critical path of every deploy — and no test applies a CR during a rolling upgrade.
Bundle also depends on cert-manager: a failed webhook cert renewal stops all deploys, with no alert
and no runbook.

### 2.3 SIGTERM during in-flight ISR revalidation
Drain is implemented and gated; what is unproven is whether a cache entry can be left **torn**
(partially written) when SIGTERM lands mid-revalidation.

---

## 3. The compat gate: what "green" must mean

Today: node lane green, bun lane red, **6 of the last 8 scheduled runs green** — flaky at shard
level. A flaky north-star gate is worse than a red one, because the natural response is to re-run
until green.

**Definition adopted:**

> 14 consecutive scheduled **node-lane** runs, every shard `failed:0` and `notRun:0`, with **zero
> net new entries in the quarantine ledger** during the window.

The quarantine clause is the load-bearing half: a pass-count-only gate is **purchasable** by moving
failures into the ledger. Measuring ledger *growth* is what makes green mean "the adapter is
correct" rather than "its known failures are catalogued." This is why **#512** is on the 1.0 path —
it is gate integrity, not polish.

**Bun is out of the 1.0 verified surface.** ADR-0036 ships `bun-exec` only on a distribution-
separated win; Run 24 found none. A target with no measured win and no green lane has no place
inside a stability promise. Bun lane red does **not** block 1.0.

### The honesty gap in the matrix
Four capability rows are not backed by hard checks, verified directly:
`compat-smoke` check `(g)` **skips** on a non-200 from the image optimizer rather than failing, so
image-optimization regressions cannot be caught; ISR runs with `REDIS_URL=""` and asserts nothing
about freshness; Server Actions are "configured, not verified"; streaming/Suspense has no evidence
at all. Each needs a red-on-fail check before 1.0.

---

## 4. The scale-to-zero claim — split it

- **"Runs Next.js on Knative with scale to zero" — SAFE at 1.0.** Run 24: 20/20 samples returned
  genuine `200`, both arms scaled to zero and woke.
- **Any cold-start *latency* claim — NOT SAFE.** 7 of 10 node cold starts landed at 10.28–11.01 s.
  At 40–70 % that is a **mode, not a tail**. Publishing "~2.4 s cold start" while most measured
  samples are ~10.5 s is the single most damaging honesty failure available to this project — cold
  start *is* the product, and the credibility strategy dies the first time an outsider measures it.

Run 24 established the mode is **target-independent**, killing the two convenient explanations
(runtime, build target). The cheapest hypothesis to falsify — and the best fit for the clean
bimodality, since a discrete event either fires or does not — is a **probe/readiness retry cycle**:
check `periodSeconds × failureThreshold` and Knative's activator retry against the ~8 s gap.

**1.0 ships** saying: *scales to zero and wakes reliably; cold-start latency is workload- and
cluster-dependent — here is the full distribution and the cluster it came from.* Publish the
distribution, never a median.

---

## 5. Phases

**P1 blocks 1.0. Every exit criterion is a red-on-fail check, not a document.**

### P1 — Freeze the contract, prove the promise
| item | issue | exit criterion |
|---|---|---|
| Prune preflight | #314 | `deploy` hard-fails when the live CRD would prune any emitted field; a removed CRD field ⇒ non-zero exit, proven by test |
| Generated compatibility artifacts | #314 | emitted-fields / CRD-schema / compatibility JSON generated and CI-asserted `⊆`; the docs matrix is **rendered** from them, never hand-written |
| Skew + upgrade-under-load e2e | #314 | operator vN-1 × CLI vN both ways; CRs applied continuously across an operator roll ⇒ 100 % admission or a clear retryable error, never a partial write |
| Cold-start attribution | #309, #536, #425 | harness records `nodeName` + scheduled/pulled/ready deltas + kubelet events **per sample**; every sample classified fast/slow with a named cause |
| Bound or scope the ~11 s mode | #309 | a named cause with a fix, **or** a published distribution + disclosed cluster scope. No median quoted anywhere |
| SIGTERM-during-revalidation | #448 | cache entry fully written or absent — never torn; `after()` completes |
| Cache-handler failure injection | — | Redis absent / refusing / timing out / garbage ⇒ fail-open + origin response in all four |
| Compat gate green | #410, #512 | the §3 definition met; every quarantine entry carries an upstream ref |
| Close the four unbacked matrix rows | — | streaming, ISR freshness, Server Actions, image-opt each behind a hard red-on-fail check |
| `tests/` type-checked | #527 | root tsconfig + CI gate — today the tier that guards everything is itself unguarded |
| Second cloud, scoped | #306 | EKS: NetworkPolicy **probed as enforced**, registry-cred expiry survived ≥ 24 h, default-SC/PVC path verified, LB idle timeout > cold-start p99 |
| ADR-0017 amendment | — | accepted ADR reconciling published packages with an alpha CRD, naming the versioning story 1.0 ships under |
| `kn-next status --explain` | — | one command joins CR conditions + revision + `nodeName` + kubelet events (delivery vehicle for cold-start attribution) |

### P2 — Operability (1.0-desirable)
Default deep-health alert · terminal image-pull condition (bad digest ⇒ terminal reason, not
indefinite `Pulling`) · lease-handover-mid-reconcile e2e · published-bundle HA assertion
(`replicas: 2` + PDB + digest-pinned manager) · observability-page correctness (#525, #534).

### P3 — Post-1.0
CRD `v1beta1` + conversion webhook · node-pressure eviction behaviour · GKE/AKS guides · #465 ·
#453 / #451 / #425 / #408 · #320 / #528 / #539.

---

## 6. Explicitly not on the 1.0 path

| cut | why |
|---|---|
| ADR-0036 `bun-exec`, bun lane — #410, #448 | no distribution-separated win exists (Run 24); no cold-start-based decision is available from this cluster |
| #441 cold-start wrapper overhead | the largest remaining perf lever, but 1.0 promises a **contract, not a latency** |
| #375 epic + #387/#388/#389 | high-traffic breadth. #387 (learned warm-schedule controller) also drifts toward general-PaaS autoscaling, against `CLAUDE.md` §1 — needs a positioning ADR before any code |
| gRPC `BackendService` — ADR-0002/3/4 | design-now-build-later; separately versioned |
| zones / PWA / MFE, #407 | app-level recipes, sequenced after adapter correctness by `.claude/rules/scs-zones.md` |
| #55 Next.js-docs listing | Track P — the *reward* for 1.0, not a component of it. Do not submit before the compat gate is stably green |

---

## 7. Stale docs to fix

- `CLAUDE.md` §4 still says the CLI generates raw Knative manifests and `deploy.ts` mutates the
  cluster. **ADR-0001 consolidation is done** — `deploy.ts` applies only the `NextApp` CR and the
  raw manifest generator is gone from `src/generators/`.
- `CLAUDE.md` lists image optimization as RESOLVED. It is **implemented but not gated** — check
  `(g)` skips rather than fails.
- #314's title still names the **retired** npm scope; the published scope is `@getknext/*`. (Spelled
  this way deliberately: `tests/npm-scope-getknext.test.ts` fails any tracked file that contains the
  retired scope literally, so even a "this one is stale" citation of it re-introduces the string the
  guard exists to keep out. Describe it, do not quote it.)
