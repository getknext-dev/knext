# ADR-0064: The knext platform layer — a cluster-scoped `KnextPlatform` config read by the operator

- **Status:** **Accepted for direction** (founder, 2026-10-03). **Proposed for design**, pending the
  sprint-close design review and the founder applying the rules-file amendments in Appendix A.
  jev on this status split: accepted-direction/proposed-design **0.87** / accepted 0.10 / proposed
  0.03.
- **Date:** 2026-10-03
- **Trigger class:** ADR + CRD + security (new CRD group, new cluster components, a privileged node
  agent). Founder-directed. Reviewed at sprint close per `.claude/rules/workflow.md` (2026-09-22
  amendment: not a merge gate).
- **Relates to / amends (proposed, see Appendix A):** ADR-0001 (operator = single source of truth),
  ADR-0028 (`containerConcurrency` default and the connection wall), ADR-0037 (image pre-pull
  DaemonSet, "opt-in, never default"), ADR-0044 (8 MiB body cap derived from concurrency 20),
  ADR-0025 and the 2026-06-26 DB-engine scope decision (no DB machinery, kept unchanged), ADR-0063
  (pre-GA release lines on integration branches).
- **Evidence:** `.claude/research/coldstart-default-config-2026-10-03.md` (classification of every
  cold-start and runtime-performance setting, §5; config sketch, §6; experiments G1–G12 / P1–P9,
  §7; the eleven rule conflicts, §8), `.claude/research/gke-image-cache-2026-10-03.md`,
  `.claude/research/oke-mirror-vs-prewarm-2026-10-03.md`.

## Context

### What the founder decided

Three statements on 2026-10-03:

1. "I want the platform to be a layer on top of knext that has its own config, not just build and
   operator."
2. "I want it baked in the platform."
3. "All best practices and anything that can improve performance and cold start speed should be
   baked in the platform."

The goal behind them is **Vercel-like defaults for a user with zero Kubernetes knowledge**. Today
knext delivers the opposite for anything above the single app. The fastest measured cold-start
levers that are not already per-app defaults live in docs pages (`image-caching`,
`pull-through-mirror`, `tuning-cold-start`) that ask the reader to label apps, edit node runtime
config, run a registry, and reason about Knative ConfigMaps. A user who cannot do that gets none of
it. The direction is decided; this ADR records **how**, and resolves the conflicts the direction
creates with existing rules.

### What the evidence says

- **Most cold-start wins already ship as per-app defaults** (rc.5): the ARP primer, the
  instrumentation gate (Bun −914 ms / Node −822 ms on GKE e2), lazy SDK clients, no default
  `emptyDir` (−361 ms GKE), aggressive readiness, baked bytecode / compile cache (Bun −538 ms). They
  need no platform field and stay where they are.
- **The platform's real cold-start job is image presence and node quality.**

  | lever | measured | conditions |
  |---|---|---|
  | `imagePrewarm` vs image absent | **+6.0 s** saved on GKE (9.83 → 3.78 s), **+8.7 s** on OKE (10.95 → 2.25 s) | one target node, 78 MB single-layer image, n=14 / n=12 per arm, complete separation vs the mirror (Holm 1.5e-7 / 1.5e-6) |
  | in-cluster pull-through mirror | **−48 %** with a remote registry (OKE→ghcr), **−12 %** same-region (GKE→AR, Holm 0.016, 0.058 under sensitivity) | same; a mirror miss costs +0.8 s (OKE) / +0.2 s (GKE) |
  | node machine family | c3 vs e2: Bun −1.28 s, Node −1.95 s | GKE only, ~+55 % price, confounded by control-plane placement |

- **The cost and risk side is real.** Prewarm places one pod and one image copy per node per app
  (5 apps × 10 nodes = 50 pods). The mirror needs node runtime config (CRI-O `registries.conf.d`
  plus SIGHUP; containerd `config_path` plus a restart on GKE COS, dropped by a node-pool upgrade),
  a stateful registry, upstream credentials (an Artifact Registry token died after ~1 h mid-run),
  and a privileged node agent. And in the OKE study **an unauthenticated pull of a private package
  succeeded through the mirror** — a mirror bypasses `imagePullSecrets` for every in-cluster client.
- **Almost every runtime-performance knob is unmeasured in knext** (compression, pooler, CDN, Redis
  eviction, target-burst-capacity, panic window, topology spread, h2c, memory limit, activator probe,
  queue-proxy resources, warm tracing overhead). jev kept today's value as the default for each of
  them, even when told the layer is decided; its confidence dropped from ~1.00 to 0.6–0.9 under that
  framing — it is weighing the *absence of measurements*, not the layer.

### Constraints this design must respect

- **One operator image serves v1.0 and 1.3 users.** Nothing may change for a cluster that has not
  opted in.
- **The v1.0 (rc.5) npm bytes are frozen** (ADR-0063); new CLI behaviour lands on a post-GA line.
- **Docs match platform reality**: a baked-in "best practice" without a measurement is a claim
  knext cannot back.
- **API facts that shape "unset"** (read from `api/v1alpha1/nextapp_types.go` and
  `src/cli/cr-builder.ts`): most `NextApp` fields are non-pointer `omitempty`, so unset and
  `0`/`false` are the same on the wire; the CLI always emits `minScale` (0) and `maxScale` (10); and
  if any one of the four resource fields is set, the CLI back-fills the other three with its own
  defaults. Only a validating webhook exists today.

## Decision

### D1. A cluster-scoped `KnextPlatform` CR, read by the operator

knext gets a **platform layer**: a new CRD, `KnextPlatform` (`platform.kn-next.dev/v1alpha1`),
**cluster-scoped, singleton** — only the object named `default` is honoured, enforced by a CEL rule
on `metadata.name`. It is the platform's own config, separate from the build CLI
(`knext.config.ts`) and from the per-app `NextApp`.

The **operator reads it** and uses it in two ways:

1. **Defaults:** when rendering an app, the operator fills **only the fields the app leaves unset**.
2. **Components:** the operator reconciles the cluster components the platform enables (the
   capped prewarm policy, later the optional image mirror and its node agent).

jev: operator-reads-CR **0.72** / separate controller 0.17 / CLI-stamps 0.11 (the research run
scored it 1.00 / 0.00 / 0.00). Cluster singleton **1.00** once the cluster-wide components are in
the question (asked without them, jev preferred namespaced 0.88 — a namespace admin must not be able
to enable a privileged node agent, so the singleton stands; a namespaced *override* CRD can be added
additively later). Own API group `platform.kn-next.dev`, so platform admins and app developers get
separate RBAC: **0.88** vs `apps.kn-next.dev` 0.12.

### D2. Precedence: app > platform > built-in, merged at render time

```
effective(field) = app.spec.field      if the app set it
                 = platform.spec.field if the platform set it (directly or via its profile)
                 = builtin(field)      otherwise
```

- **Render-time merge, never a spec write.** The operator merges into the rendered Knative Service
  (and the objects derived from the app) at reconcile time. `NextApp.spec` stays exactly as authored,
  so GitOps diffs stay clean and a platform edit propagates without touching any app object. jev
  render-time **0.96** / mutating webhook 0.04.
- **"Unset" is the wire's unset.** A zero-valued `omitempty` field is unset. That matches today:
  `containerConcurrency: 0` already maps to the operator default. Two consequences are documented,
  not fixed, in P0: (a) `minScale`/`maxScale` are always emitted by the CLI, so the platform does not
  default them (minScale 0 is the product promise anyway); (b) an app that sets one resource field
  gets the CLI's back-fill for the other three, which counts as app-set. A 1.4 CLI change (emit only
  the fields the user set) is action item P2-3.
- **Built-in = today's operator constants**, moved into one table (`containerConcurrency` 20, CPU
  250m / 1000m, memory 512Mi / 1Gi, connection budget 80, timeout 300 s). Every platform field's
  default is the built-in value.
- **Observability of the merge.** `NextApp.status.platform` (additive) records the observed platform
  generation, the profile, and the list of fields the app inherited from the platform. A new
  `PlatformDefaultsApplied` condition is computed in `computeStatusVerdict` (never a new `Reconcile`
  branch — architecture.md §4).

### D3. Empty platform equals today's behaviour (the zero-diff guarantee)

- **No `KnextPlatform` object** ⇒ built-in defaults ⇒ byte-identical rendering to the operator
  before this ADR.
- **An empty `KnextPlatform`** (`spec: {}`) or `profile: default` ⇒ the same.
- **The operator install bundle ships the CRD but no `KnextPlatform` object.** Upgrading the
  operator therefore changes nothing. New users get the defaults through a separate one-line profile
  apply in the quickstart, which existing installs never run. jev bundle-without-CR **0.93** / bundle
  with a `fastColdStart` CR 0.06 / operator-built-in profile 0.01.
- **The quickstart does not apply `fastColdStart` until G12 has run.** Until the combined-profile
  measurement (G12) exists, the quickstart applies nothing, or `profile: default` at most, and the
  docs make no claim for `fastColdStart`. Switching the quickstart to `fastColdStart` is a separate
  docs PR that cites G12.
- **The CRD may be missing, and the operator must still start.** An operator upgraded on a cluster
  where the `KnextPlatform` CRD was not installed (a partial bundle apply, or a GitOps tool that
  syncs CRDs separately) must start and behave exactly as today.
  - `SetupWithManager` registers the `KnextPlatform` watch **only if discovery reports the CRD**.
    The watch list lives at `nextapp_controller.go:2058–2079`; the Revision watch mapping at `:2030`
    is the nearest precedent for a non-owner watch.
  - When the CRD is absent, the operator uses built-ins, logs once, and reports
    `PlatformDefaultsApplied=True, reason=NoPlatformCRD`.
  - When the CRD appears later, the operator picks it up on its next restart or discovery refresh.
    It never crash-loops on a missing kind.
- **Platform identity lives only in status, never in the revision template.** The platform
  generation, the profile name and the inherited-field list are written to `NextApp.status.platform`
  only. They never go into the Knative Service's revision template: no annotation, label or env
  carries them. So an operator upgrade, or a platform edit that leaves every effective value
  unchanged, creates **no new revision**. Only a change to an effective rendered value (D2) changes
  the template.
- **Proved, not asserted:** a golden test renders a fixture corpus of CLI-emitted `NextApp`s (v1.0
  and 1.3 CLI shapes) in **four** cases:
  1. the `KnextPlatform` CRD is not installed at all;
  2. the CRD is installed with no CR;
  3. the CR is `spec: {}`;
  4. the CR is `profile: default`.

  In every case the test diffs **every object the operator renders from a `NextApp`** against the
  current operator's output, byte for byte, and not only the Knative Service:
  - the Knative Service, including the full container env and the revision-template annotations;
  - the ServiceAccount;
  - the `NetworkPolicy`;
  - the `<app>-imgcache` DaemonSet;
  - the Knative `Image`;
  - the `KafkaSource`, where rendered.

  The guard is mutation-proved. jev on this P0 shape **0.80** yes.

### D4. Profiles

`spec.profile` names a bundle of platform values. A profile only ever sets values a user could have
set field by field; explicit platform fields override the profile.

| profile | sets | status |
|---|---|---|
| `default` | nothing (= built-ins) | P0 |
| `fastColdStart` | prewarm policy `mode: all` (capped, D5); enables the platform `doctor` checks' "fail" severity | P1 ships it; **its benefit is quoted only after G12** (the combined A/B vs rc.5) |
| `latencySensitive` (selector-scoped) | prewarm on, `scaleDownDelay: 15m` for apps matching a label | later, after G11 |

What `fastColdStart` deliberately **does not** set: the mirror (needs credentials and a node agent:
jev keep-off **0.72**), CPU boost, activator probe, queue-proxy resources, h2c, compression, memory —
all unmeasured. The runtime (Node vs Bun) is **never** a platform value (jev **0.61**): it stays
per-app so Node is always an option.

### D5. The image prewarm policy (capped)

`spec.images.prewarm`:

- `mode: off | selected | all` — default `off`.
- `selected` applies to apps matching `selector` (an app label set from `knext.config.ts`).
- `all` applies to every `minScale: 0` app, newest-deployed first, **up to `maxApps`** (default 5).
- The operator reuses the ADR-0037 reconciler unchanged: the effective `imagePrewarm` is
  `app.imagePrewarm || policySelected(app)`, and the `<app>-imgcache` DaemonSet is still owned by the
  `NextApp`.
- `KnextPlatform.status.prewarm` lists the apps prewarmed and the apps skipped by the cap, so the cost
  (apps × nodes pods and image copies) is visible.
- **Opt-out** is "not selected". In `selected` mode that is the default. In `all` mode the cap and
  the status list bound it. An explicit per-app opt-out (`imagePrewarm` as a tri-state) is **not**
  in P1: jev selector-only **0.56** / tri-state 0.39 / annotation 0.05 (conf 0.34, low; revisit if
  `all` mode is used in practice).

jev on the policy shape: selector-capped **0.94** / on for every minScale-0 app 0.04 / app-only
0.02. On what `fastColdStart` selects: all-capped **0.49** / label-only 0.26 / none 0.25 (conf 0.23 —
the weakest call in this ADR; G12 is what validates it).

### D6. Components the platform may install — and nothing else

The platform layer may install exactly these, each opt-in, each reconciled by the operator:

1. **The prewarm policy** (D5) — DaemonSets as in ADR-0037.
2. **The optional image mirror** (phase 3) — a pull-through registry (digest-pinned, proxy mode,
   push disabled), its storage, TLS, a `NetworkPolicy`, and its **node agent** DaemonSet (D8).
   Off by default, including in `fastColdStart`.
3. **`doctor` checks** — read-only, in the CLI (phase 2): platform CR present and observed by the
   operator; CNI enforces `NetworkPolicy` (flannel does not); registry region vs node region;
   pre-rc.5 scaffold still importing instrumentation eagerly; a `LimitRange`
   `maxLimitRequestRatio` the effective resources would trip; shared-core machine family.

**Not** installed, ever, by this ADR: a database, a pooler, Redis, a CDN, an ingress, Spegel, a
startup-CPU-boost controller, or any Knative config change (D7). Each of those needs its own ADR,
and most are excluded outright by the boundary in the Resolution of conflict 1.

### D7. No Knative config writes

The platform layer **does not write** `knative-serving` ConfigMaps, the activator's environment, or
Knative feature flags. `doctor` may read them and report drift. Any future write (activator probe
G2, queue-proxy resources G4, `podspec-nodeselector` for node preferences) needs its own ADR after
its experiment. jev never-now **0.97** / a `knative.manage` flag 0.03. As a result, node
preferences and topology spread (which need Knative feature flags) are out of phase 1–3.

### D8. The mirror node agent: operator-managed, least privilege, tiered by runtime

- **Ownership:** an operator-managed DaemonSet, created only when `images.mirror.enabled`, owned by
  the `KnextPlatform`, reverting its host changes on `preStop` and through a `KnextPlatform`
  finalizer. jev operator DaemonSet **0.98** / separate install 0.01 / cloud-init only 0.01 (with
  the founder's "baked in" decision and ADR-0001 in the question; without them it was a near tie,
  separate install 0.51 / operator 0.44).
- **Least privilege, tiered by what each runtime needs** (jev tiered **0.70** / one fully
  privileged agent 0.28 with the security rules in the question; without them jev preferred the
  fully privileged agent 0.63 — overridden by `security.md`, recorded here):

  | node runtime | host access | writes |
  |---|---|---|
  | containerd with `config_path` | none beyond one `hostPath` directory | `certs.d/<registry>/hosts.toml` |
  | CRI-O | `hostPID` + `CAP_KILL` only, to SIGHUP crio (`--auto-reload-registries` is off by default) | one `registries.conf.d/90-knext-mirror.conf` drop-in |
  | containerd **without** `config_path` (GKE COS) | **refused** with `NodeAgentReady=False, reason=RuntimeRestartRequired` unless `allowRuntimeRestart: true` is set explicitly | `config.toml` edit + restart; the status says a node-pool upgrade drops it |

- The agent runs in its own namespace with `pod-security.kubernetes.io/enforce: privileged`, so the
  operator's namespace stays restricted. Its image is built in-repo, distroless, digest-pinned,
  signed and SBOM'd like every other knext image. No ServiceAccount token, egress denied, read-only
  root, an allowlist of exactly the paths above.

### D9. Runtime-performance defaults stay at today's values until measured

Every runtime-performance field the platform eventually exposes is created with **today's value as
its default**. A default changes only when its experiment (G1–G12, P1–P9 in the research, §7) has
produced a Holm-corrected result with stated conditions, and then through a reviewed PR that cites
it. Docs quote only measured numbers, with their conditions; G12 is the only number a profile may
quote. jev **0.54** yes (weak — the founder's "baked in" pulls the other way; this rule is what keeps
"baked in" honest rather than what delays it).

### D10. The CLI does not write the platform CR

`KnextPlatform` is applied with kubectl or GitOps. The CLI reads it in `doctor` only, so every CLI
cluster write still targets `NextApp` and nothing else (CLAUDE.md §4). jev never **0.89** /
`kn-next platform apply` 0.11.

## Component boundaries and contracts

### CRD schema sketch (P0 is minimal; later fields are additive)

jev minimal-per-phase schema **0.96** / the full research sketch now 0.04. Fields marked with a
phase appear only when that phase lands.

```yaml
apiVersion: platform.kn-next.dev/v1alpha1
kind: KnextPlatform
metadata:
  name: default                 # CEL: self.metadata.name == 'default'
spec:
  profile: default              # default | fastColdStart          (P0 enum; fastColdStart effective P1)
  scaling:
    defaults:                   # P0 — each unset ⇒ built-in
      containerConcurrency: 20
      scaleDownDelay: ""
      targetBurstCapacity: null
      panicWindowPercentage: null
      panicThresholdPercentage: null
  resources:
    defaults: { cpuRequest: 250m, cpuLimit: 1000m, memoryRequest: 512Mi, memoryLimit: 1Gi }   # P0
  limits:
    timeoutSeconds: 300         # P0
  database:
    connectionBudget: 80        # P0 — today's hardcoded maxScale × poolMax cap (see conflict 9)
  rollout:
    maxAppsPerMinute: 10        # P0 — bounds platform-triggered re-renders (failure mode F2)
  images:
    prewarm:                    # P1
      mode: off                 # off | selected | all
      selector: {}              # LabelSelector, used by `selected`
      maxApps: 5
    mirror:                     # P3 — absent ⇒ disabled
      enabled: false
      upstreams: []             # repository PREFIXES, never a whole registry host
      credentialsSecretRef: {}  # Secret in the platform namespace; never inline
      storage: { size: 50Gi, storageClassName: "" }
      nodeAgent:
        allowRuntimeRestart: false
      allowUnenforcedNetworkPolicy: false   # see F4
status:
  observedGeneration: 3
  conditions: []                # Accepted, Ready, DefaultsPropagated; P1 PrewarmPolicyReady;
                                # P3 MirrorReady, NodeAgentReady, MirrorUpstreamAuthFailing
  rollout: { pending: 0, applied: 42, held: 1 }
  prewarm: { selected: [], skippedByCap: [] }
```

Validation lives in the CRD (OpenAPI + CEL), plus admission **warnings** (not rejections) for:
a `connectionBudget` below an existing app's `maxScale × poolMax`; a default
`containerConcurrency × 8 MiB` above the default memory limit (the ADR-0044 arithmetic).

### Ownership

| object | owner | writer |
|---|---|---|
| `KnextPlatform` | the cluster admin (kubectl / GitOps) | never the CLI, never the operator (except `status` and its finalizer) |
| rendered Knative Service, ServiceAccount, `NetworkPolicy`, `<app>-imgcache` | `NextApp` (unchanged) | operator |
| mirror Deployment, Service, PVC, TLS Certificate, `NetworkPolicy`, node-agent DaemonSet | `KnextPlatform` (cluster-scoped owner) | operator |
| host drop-in files | the node-agent pod | node agent, reverted on `preStop` + finalizer |

### Status conditions

- **`KnextPlatform`:** `Accepted` (schema valid, singleton name), `DefaultsPropagated` (all
  inheriting apps re-rendered, or `Progressing` with counts), `Ready`; P1 `PrewarmPolicyReady`; P3
  `MirrorReady`, `NodeAgentReady` (per-runtime reason), `MirrorUpstreamAuthFailing`.
- **`NextApp`:** `PlatformDefaultsApplied` — `True` with reason `Inherited`, `NoPlatform` or
  `NoPlatformCRD`;
  `False` with reason `EffectiveSpecInvalid` (names the field) or `PlatformNotAccepted`. Computed in
  `computeStatusVerdict`.

### Versioning and upgrade order

- **`v1alpha1`, additive only.** No field is renamed, re-typed or removed within `v1alpha1`; any
  such change is a new version with conversion, under its own ADR. Platform fields default to the
  built-in, so an absent field always means today's behaviour.
- **Upgrade order: operator/CRD first, then the `KnextPlatform`, then the 1.4 CLI** (`doctor`).
  This is the existing rule (CLAUDE.md §4). Applying a `KnextPlatform` before its CRD exists fails
  closed (no CRD, no object).
- **Downgrade:** an older operator ignores the CR, so behaviour reverts to built-ins.
  `status.observedGeneration` stops advancing, and `doctor` reports it.
- **v1.0 and 1.3 users on the shared operator are unaffected:** the bundle ships no platform
  object (D3); the `NextApp` CRD change is an additive `status.platform` field; the golden zero-diff
  test gates every operator release. The only new operator permissions are `get/list/watch` on
  `knextplatforms` (P0) and the component RBAC (P3, effective only when enabled).
- **Release line:** the 1.4 line, on its own integration branch per ADR-0063; never the v1.0 frozen
  bytes. jev 1.4-integration **0.94** / v1.0 0.05 / 1.3 0.01.

## Options considered

### Mechanism (the load-bearing choice)

| option | how | for | against | jev (this ADR / research) |
|---|---|---|---|---|
| **A. Operator reads a cluster-scoped CR (chosen)** | `KnextPlatform`, merged at render under app fields | one writer of cluster state (ADR-0001); a platform edit propagates to every app with no app change; GitOps-friendly; status shows what was inherited | new CRD and operator code; the operator must watch one more kind; platform edits can roll many apps at once (F2) | **0.72 / 1.00** |
| B. CLI stamps values into each `NextApp` | the CLI reads a platform file and writes values into the CR | no operator change | apps deployed by an older CLI or by GitOps never get defaults; a platform change needs every app redeployed; app > platform precedence is lost (stamped values look app-set) | 0.11 / 0.00 |
| C. Separate platform controller | a new controller patches `NextApp`s and owns components | isolates platform code | two writers of the same objects — the ADR-0001 failure mode; a second deployable for users to install and upgrade | 0.17 / 0.00 |

### Secondary choices (all jev-scored; top option chosen)

| decision | chosen | jev |
|---|---|---|
| where to merge | render-time | 0.96 vs mutating webhook 0.04 |
| API group | `platform.kn-next.dev` | 0.88 vs `apps.kn-next.dev` 0.12 |
| scope | cluster singleton | 1.00 (with cluster components in context) |
| install bundle | CRD only, no CR | 0.93 |
| P0 schema | minimal per phase | 0.96 |
| prewarm policy | selector / all, capped | 0.94 |
| prewarm opt-out | selection only, no tri-state yet | 0.56 (conf 0.34) |
| `fastColdStart` prewarm selection | all minScale-0 apps, capped | 0.49 (conf 0.23) |
| Knative config writes | none in this ADR | 0.97 |
| node agent owner | operator DaemonSet | 0.98 |
| node agent privilege | tiered by runtime, refuse restarts by default | 0.70 |
| mirror private-image protection | NP to node IPs + TLS + refuse on non-enforcing CNI unless acknowledged | 0.98 |
| CLI writes the CR | never | 0.89 |
| platform-change rollout | rate-limited | 0.99 |
| platform change invalidates an app | hold last-good + condition + admission warning | 0.78 |
| CR deleted | revert to built-ins, rate-limited; finalizer reverts host config first | 0.89 |
| `containerConcurrency` | one built-in table; platform may override; scaffold's 100 stays app-set until G3 | 0.78 |
| mirror in `fastColdStart` | off | 0.72 yes |
| defaults stay today's until measured | yes | 0.54 yes |
| release line | 1.4 integration branch | 0.94 |
| status | accepted direction, proposed design | 0.87 |
| file issues now or after review | list issue-ready, file after review | 0.94 |

jev reads literally: it is a gut check recorded beside each call, not the decision. Where adding a
missing fact flipped an answer (scope, node-agent owner, node-agent privilege), both scores are given
above.

## Resolution of the rule conflicts (research §8)

Each resolution ends with the amendment it needs. The wording is in Appendix A, **proposed for the
founder to apply** — `CLAUDE.md` and `.claude/rules/` are the maintainer's files, and this PR does
not edit them.

1. **CLAUDE.md §1 / §10 — "NOT a general-purpose PaaS".** The boundary is restated, not dropped.
   knext stays the Next.js-on-Knative adapter. The platform layer is **opinionated runtime defaults
   and cold-start components for Next.js apps on Knative** — image presence, scaling and resource
   defaults, read-only cluster checks. The boundary has **three parts, and all three apply
   together**. Passing one does not excuse failing another.

   1. **Explicit exclusion list.** The platform never installs or provisions:
      - a database, a pooler, or any DB machinery;
      - a cache server (Redis or similar);
      - a CDN;
      - an ingress, gateway or load balancer;
      - a general app-hosting or deploy-anything component (non-Next workloads, arbitrary
        containers).
   2. **The field test.** A platform field or component must change how a `NextApp` starts or
      serves. If it does not, it is out.
   3. **New components need their own ADR.** Phases 0–3 permit only the components listed in D6.
      Any other component, even one that passes 1 and 2, needs its own ADR before it ships.

   jev **0.61** yes that this restatement reconciles the two. **Amendment A1** (CLAUDE.md §1, §10).
2. **architecture.md §5 — "if a request expands scope, say so and recommend sequencing".** Said so
   (this ADR), and sequenced: after v1.0 GA, on the 1.4 line, P0 with zero behaviour change, each
   component behind its own phase, each default behind its experiment. No rule change needed;
   **Amendment A2** adds a pointer in architecture.md §4 so the next reader finds this ADR.
3. **scs-zones.md scope boundary, and the earlier "cluster-wide components stay recipes"
   verdicts** (mirror recipe 0.97, quoted by distance 0.98). The founder's direction changes the
   question, not the evidence: the mirror moves from a docs recipe to an **optional platform
   component, off by default, quoted by registry distance** (jev platform 0.95 in the research).
   Spegel stays out (failed on GKE, impossible on CRI-O). The zones contract itself (data
   sovereignty; SW/MFE/PWA stay app-level) is untouched. **Amendment A3** (scs-zones.md "knext owns
   today").
4. **ADR-0001 — operator is the single source of truth.** Kept, in its strong form. (i) The platform
   CR is **read** by the operator; nothing else applies defaults. (ii) The node agent is an
   **operator-managed DaemonSet** whose host writes are bounded to one drop-in per runtime and
   reverted by `preStop` and a finalizer: the operator is still the single writer of Kubernetes
   state, and host state is written only by a pod the operator owns. (iii) **No Knative config
   writes** (D7), so research §8 item 4(ii)/(iii) does not arise in phases 0–3. (iv) The CLI never
   writes the platform CR (D10). **Amendment A4** (an ADR-0001 note).
5. **ADR-0037 — `imagePrewarm` "opt-in, never default".** Per app it stays off and opt-in. It
   becomes **a capped platform policy**: off in the `default` profile and when no CR exists; on
   only when a cluster admin sets `images.prewarm.mode` or chooses `fastColdStart`, always bounded by
   `maxApps` and reported in status. **Amendment A5** (an ADR-0037 note: "never on by default for an
   app or in the default platform profile").
6. **security.md — a privileged node agent, mirror credentials, `insecure = true`, the push path.**
   Least privilege by runtime tier (D8); opt-in only; no `insecure` HTTP mirror in the shipped
   component (TLS via cert-manager, which the operator's webhook already requires); push disabled
   (proxy mode), so the mirror exposes **no mutating endpoint**; upstream credentials only in a K8s
   Secret by reference; its own section in `docs/security/threat-model.md` (action P3-5) before the
   component ships. **Amendment A6** (security.md "Runtime hardening").
7. **workflow.md triggers.** This touches `docs/adr/`, adds a CRD, and adds security surface — all
   trigger-class. Acknowledged in the PR body; reviewed at sprint close. Each later phase that adds a
   CRD field or a component carries the same acknowledgement. No amendment.
8. **ADR-0028 / ADR-0044 / the scaffold — concurrency 20 vs scaffold 100, 8 MiB derived from 20.**
   The operator constant becomes the **single built-in table**; the platform may override it per
   cluster; the scaffold's `containerConcurrency: 100` is an app-set value and keeps winning. The
   number lives in two places that have a defined order (built-in < platform < app), not three
   competing ones. G3 (cold 50-request burst, 20 vs 100) decides whether the 1.4 scaffold drops its
   override. The admission warning catches a platform default whose concurrency × 8 MiB exceeds the
   default memory limit. jev **0.78**. **Amendment A7** (an ADR-0028 note).
9. **The DB-engine scope decision (2026-06-26, ADR-0025).** Kept. The platform builds **no** DB
   machinery: no engine, no pooler component, no provisioning (pooler none 0.91 in the research).
   `database.connectionBudget` only turns today's hardcoded cap of 80 into a per-cluster value; it
   creates nothing. jev that this field violates the decision **0.32** yes (i.e. it does not). No
   amendment.
10. **Docs match platform reality.** D9 is the rule: platform fields default to today's values;
    each default changes only with a cited measurement; profile benefits are quoted only from G12.
    No amendment (the rule already exists; this ADR binds the platform to it).
11. **Node is always an option.** No conflict: the platform never selects or defaults the runtime
    (D4). No amendment.

Also preserved: **CLAUDE.md §4, "every CLI cluster write targets the `NextApp` CR"** — the CLI only
reads the platform CR (D10). **Amendment A8** adds that sentence explicitly so it is not
re-litigated.

## Failure modes and security

- **F1 — Node agent compromise.** Blast radius: root-equivalent on every node where it runs (CRI-O
  tier: can signal any host process; restart tier: can restart the runtime). Mitigations: opt-in
  only (mirror disabled ⇒ no agent); tiered privilege (D8); dedicated privileged namespace; in-repo
  distroless image, digest-pinned, cosign-signed, SBOM + Trivy gate; no ServiceAccount token; egress
  denied; read-only root; path allowlist. Residual risk is stated in the threat model, not hidden.
- **F2 — Platform edit rolls every app at once.** Each changed template is a new Knative revision,
  and initial-scale 1 boots one pod per revision. The operator re-renders inheriting apps at
  `rollout.maxAppsPerMinute` and reports progress in `status.rollout`. jev rate-limited **0.99**.
- **F3 — A platform change makes an app's effective spec invalid** (e.g. a lower
  `connectionBudget`). The operator **holds** that app's current Knative Service, sets
  `PlatformDefaultsApplied=False, reason=EffectiveSpecInvalid` naming the field, and admission warns
  with the affected apps when the platform CR is applied. jev hold-last-good **0.78** / reject the
  platform change 0.12 / apply anyway 0.10.
- **F4 — Mirror serves private images to any pod.** The mirror pulls with upstream credentials and
  serves without `imagePullSecrets`. Mitigation: a `NetworkPolicy` admitting only node-originated
  traffic (runtime pulls leave from the host network namespace; whether that arrives as the node IP
  or a CNI bridge address is CNI-dependent and is pinned per CNI in the P3-4 drill, not assumed),
  TLS, upstreams scoped by repository prefix. **On a CNI
  that does not enforce `NetworkPolicy` (flannel: OKE GA, OrbStack), the operator refuses to enable a
  credentialed upstream** (`MirrorReady=False, reason=NetworkPolicyNotEnforced`). **Fail closed:**
  enforcement must be *proven*, not inferred from a CNI name. The operator runs an active probe: a
  short-lived pod that the mirror's policy should deny tries to connect, and must be refused.
  An unknown CNI, a probe that cannot run, or an inconclusive probe all count as **non-enforcing**,
  and the refusal holds unless `allowUnenforcedNetworkPolicy: true` is set. jev **0.98** / warn only 0.01 / public upstreams only
  0.01.
- **F5 — Mirror credentials.** Stored only in a K8s Secret referenced by name; never in the CR,
  logs or the image. Short-lived tokens (Artifact Registry ~1 h) are not supported in phase 3; a
  failing upstream sets `MirrorUpstreamAuthFailing`, and `doctor` names the cause.
- **F6 — Mirror down or wrong.** CRI-O mirror lists and containerd `hosts.toml` are both designed
  to fall back to the upstream registry when a mirror fails, so an outage should degrade to today's
  direct pull plus a miss cost (+0.8 s OKE / +0.2 s GKE), not an outage. **This is an expectation,
  not a measurement:** the P3-4 drill must confirm it per runtime before the component ships.
- **F7 — Node-pool upgrade drops host config** (GKE COS restart tier). The agent re-applies on its
  next start on the new node; `NodeAgentReady` reports per node. Until then the node pulls direct
  (F6).
- **F8 — `KnextPlatform` deleted.** Apps revert to built-in defaults at the bounded rate;
  platform-owned components are removed; the finalizer first runs the node agent's revert and waits
  for it per node. jev revert **0.89** / block deletion 0.08 / freeze 0.03.
- **F9 — Rollback.** Edit or revert the CR (GitOps) — that is the rollback. An operator downgrade
  reverts to built-ins (unknown CR ignored). Removing `images.mirror` reverts host config through the
  same path as F8.
- **F10 — Older operator, newer platform field.** The CRD and operator ship in one bundle, so they
  move together. A `KnextPlatform` written for a newer CRD fails strict validation on an older one
  (fail closed, the same as `NextApp`).
- **No new mutating endpoint.** The operator adds no HTTP surface; the mirror is pull-only.

## Consequences

- knext gains a second user-facing config (`KnextPlatform`) and a new audience (the cluster admin).
  Docs need a platform reference page and a quickstart line; the docs must not imply that the
  platform changes anything when absent.
- "Baked in" becomes real for image presence first (the largest measured win). For runtime
  performance it is a set of fields, created as experiments land, defaulting to today until each is
  measured. That is slower than the founder's sentence reads, deliberately, and is stated here.
- The operator gets a watch on one more kind, a merge step, a rollout limiter, and later a
  component reconciler; the status verdict grows one condition.
- The "unset" semantics inherited from `omitempty` fields limit what the platform can default for
  apps an older CLI deployed (resources back-fill, always-emitted min/max scale). The limitation is
  visible in `status.platform` and partly removed by P2-3.
- The `fastColdStart` prewarm selection is the weakest call here (jev 0.49, conf 0.23). G12 decides
  whether it stays.

## Action items (issue-ready; file after the sprint-close review accepts the design)

Release line: **1.4**, on its integration branch (ADR-0063). Operator changes are additive and
gated by the zero-diff test, so they can ship in an operator release that v1.0 and 1.3 users also
run.

### Phase 0 — CRD and defaulting, no behaviour change

- **P0-1** `KnextPlatform` CRD (`platform.kn-next.dev/v1alpha1`, cluster-scoped, CEL singleton
  `default`, P0 fields only) + envtest for admission. *Exit:* invalid names and fields rejected;
  `spec: {}` accepted.
- **P0-2** Operator built-in defaults table: move today's constants (concurrency 20, resources,
  timeout 300, connection budget 80) into one table with no value change. *Exit:* existing tests
  unchanged and green.
- **P0-3** **Zero-diff golden guard.** A fixture corpus of v1.0 and 1.3 CLI-emitted `NextApp`s is
  rendered in four cases: the CRD not installed, the CRD with no CR, `spec: {}`, and
  `profile: default`.
  - The guard diffs **every** object the operator renders from a `NextApp`, byte for byte: the
    Knative Service (container env and revision-template annotations included), the ServiceAccount,
    the `NetworkPolicy`, the `<app>-imgcache` DaemonSet, the Knative `Image`, and the `KafkaSource`
    where rendered.
  - It also asserts that no platform generation or profile value appears in any revision template.
  - Mutation-proved.
  - *Exit:* the guard reds when any built-in value changes, when any rendered object differs, and
    when platform identity leaks into a template.
- **P0-3b** **CRD-absent startup.** `SetupWithManager` (`nextapp_controller.go:2058–2079`) registers
  the `KnextPlatform` watch only when discovery reports the CRD. Without the CRD, the operator starts,
  uses built-ins, and reports `reason=NoPlatformCRD`.
  - *Exit:* an envtest starts the manager with the `KnextPlatform` CRD not installed, and the manager
    becomes ready and reconciles a `NextApp`.
- **P0-4** Render-time merge (app > platform > built-in), `NextApp.status.platform`, and the
  `PlatformDefaultsApplied` condition in `computeStatusVerdict`. *Exit:* envtest per precedence
  layer, per field.
- **P0-5** Rollout limiter (`rollout.maxAppsPerMinute`), hold-last-good on an invalid effective spec,
  admission warnings (connection budget, concurrency × 8 MiB vs memory), and revert on deletion.
  *Exit:* envtest for F2, F3 and F8.
- **P0-6** RBAC: operator `get/list/watch` on `knextplatforms`; a `knextplatform-admin`
  ClusterRole; app-editor roles exclude it. *Exit:* RBAC contract test.
- **P0-7** Docs: platform configuration reference + upgrade order (operator first) + "absent means
  unchanged". No internal references in user-facing pages.

### Phase 1 — the prewarm policy and `fastColdStart`

- **P1-1** `images.prewarm` (`off | selected | all`, `selector`, `maxApps`), reusing the ADR-0037
  reconciler; `status.prewarm` lists selected and skipped apps; `PrewarmPolicyReady`.
- **P1-2** `profile: fastColdStart` = prewarm `all`, capped. *Exit:* envtest; kind e2e; OKE verify
  that an app with an absent image starts without a `Pulling` event.
- **P1-3** **G12:** the combined `fastColdStart` vs rc.5 A/B on OKE, image absent and present,
  n=12/arm. The only number docs may quote for the profile.
- **P1-4** Quickstart: switch the quickstart's profile line to `fastColdStart` **only after P1-3
  (G12) has run**, citing its result with conditions. Until then the quickstart applies no profile,
  or `default` at most.

### Phase 2 — `doctor` checks (CLI, 1.4)

- **P2-1** Read-only platform checks: CR present and `observedGeneration` current; CNI enforces
  `NetworkPolicy`; registry region vs node region; pre-rc.5 eager instrumentation import;
  `LimitRange` ratio vs effective resources; shared-core machine family.
- **P2-2** `doctor` reports which fields each app inherits (reads `status.platform`).
- **P2-3** CLI emits only user-set resource fields (removes the back-fill that shadows platform
  defaults). Trigger-class (CLI surface).

### Phase 3 — the optional image mirror

- **P3-1** Mirror component: digest-pinned pull-through registry, push disabled, PVC, cert-manager
  TLS, `NetworkPolicy` to node IPs, repository-prefix upstreams, Secret-referenced credentials;
  `MirrorReady`, `MirrorUpstreamAuthFailing`.
- **P3-2** Node agent, tiered per D8; `preStop` revert; `KnextPlatform` finalizer; `NodeAgentReady`
  with per-runtime reasons; refuse-by-default on the restart tier and unless `NetworkPolicy`
  enforcement is proven by an active deny probe (unknown CNI or an inconclusive probe ⇒ refuse;
  F4).
- **P3-3** Node-agent image: in-repo, distroless, cosign + SBOM + Trivy gate.
- **P3-4** Drills: fallback on mirror outage (F6), node-pool upgrade (F7), deletion revert (F8), on
  kind (containerd), OKE (CRI-O) and GKE (containerd without `config_path`).
- **P3-5** Threat-model section in `docs/security/threat-model.md` for the node agent and the
  mirror — **before** P3-1/P3-2 merge.
- **P3-6** Docs: replace the pull-through-mirror recipe with the platform option, quoting the
  benefit by registry distance (−48 % remote / −12 % same-region, with conditions).

### Phase 4 — experiments that may promote a default (one issue each)

Each runs under the shared protocol (in-cluster client, interleaved blocks, Holm correction; cluster
work is a queue of one) and may add **one** additive field whose default changes only on a
significant result:

- **G1** GKE image streaming · **G2** activator probe · **G3** concurrency 20 vs 100 under a cold
  burst · **G4** queue-proxy resources · **G5** memory limit · **G6** image GC vs prewarm pinning ·
  **G7** self-contained Bun on OKE · **G8** startup CPU boost · **G9** crun / EventedPLEG /
  control-plane co-location · **G10** remaining eager imports · **G11** retention period.
- **P1** Redis eviction under ISR churn · **P2** asset serving pod / bucket / CDN · **P3**
  compression · **P4** next/image cache · **P5** keep-alive + h2c · **P6** target utilization and
  burst capacity · **P7** CPU / memory right-sizing · **P8** warm tracing overhead · **P9** React
  Compiler bundle size.

G2, G4 and the node-preference half of G9 would need Knative config writes; each needs its own ADR
before any field ships (D7).

## Phase 0 implementation notes (as built)

Recorded so the sprint-close review reads the build, not the plan. Nothing here changes a
decision above; each item is a place the build had to choose within it.

- **Landed:** P0-1 (CRD + admission envtest), P0-2 (`internal/defaults`), P0-3 (zero-diff golden:
  25 CLI-shaped specs x 8 platform states, golden recorded before any platform code existed),
  P0-3b (start-up envtest without the CRD), P0-4, P0-5 except the admission warnings, P0-6
  (operator `get/list/watch` plus `update/patch` on the platform's **status** only; the platform's
  own reconciler writes `Accepted`, `DefaultsPropagated`, `Ready` and the rollout counts), P0-7.
- **Deferred:** the two admission **warnings** in P0-5 (a `connectionBudget` below an existing app's
  `maxScale x poolMax`; a default `containerConcurrency x 8 MiB` above the default memory limit).
  They need a second validating webhook. The effect they warn about is already reported at
  reconcile time (`EffectiveSpecInvalid`, a Warning event, last-good held). Tracked as sprint-close
  tech debt.
- **`status.platform`** carries two more fields than D2 lists, `specHash` and `effectiveHash`. The
  hash of the platform's spec (not its generation) is the stamp that says "this app was rendered
  against this configuration", so deleting and recreating an unchanged platform is not a change.
  The hash of the merged values that reach the revision template is how the operator knows a
  platform edit would roll **no** new revision for an app without diffing a live Knative Service,
  whose Knative-defaulted fields differ from a fresh render on every pass.
- **The rollout limiter is a reservation limiter**, not a token bucket: a held app is told when its
  slot is and comes back then (two reconciles per app, not a poll loop). An app's **own** spec
  change, an app with no Service yet, and an edit that changes nothing for the app all bypass it.
  The pacing rate lives in the platform, so once the platform is deleted (F8) the built-in rate
  governs the revert.
- **A platform that fails the operator's own validation is ignored, not held** (built-in defaults,
  `PlatformDefaultsApplied=False, reason=PlatformNotAccepted`, a Warning event). Hold-last-good (F3)
  is reserved for a platform value that makes an *app's merged spec* invalid. jev: ignore 0.92 / hold
  0.08.
- **Added reasons on `PlatformDefaultsApplied`:** `NothingToInherit` (a platform is in force but
  supplies no value the app leaves unset) and `RolloutPending` (`Unknown`; queued behind the
  limiter). The ADR's `NoPlatform`, `NoPlatformCRD`, `Inherited`, `EffectiveSpecInvalid` and
  `PlatformNotAccepted` are as written.
- **The NextApp admission webhook reads the platform's `connectionBudget`** (one uncached GET, only
  when the CRD is installed, built-in 80 on any read problem), so write-time and reconcile-time
  agree. Without it a platform that raised the budget would be silently contradicted at
  `kubectl apply`. jev: read 0.96 / stay at 80 0.04.
- **`scaling.defaults` is in P0** because the schema sketch marks it P0 (jev: include 0.91). The
  one built-in it moves is `containerConcurrency` 20.
- **CLI.** The CLI no longer always emits `minScale`/`maxScale` (D2 consequence a): it omits
  `spec.scaling` when nothing scaling-related is set, and keeps `maxScale` present in any block it
  does emit, because the operator reads a present block's `maxScale` literally and 0 is Knative's
  "unbounded". The resource back-fill (D2 consequence b, action P2-3) is **not** changed here.

## Appendix A — rules-file and ADR amendments, proposed for the founder to apply

This PR edits none of these files. Exact proposed wording:

- **A1 — `CLAUDE.md` §1**, append to the "NOT a general-purpose PaaS" bullet:
  > **Platform layer (ADR-0064, founder 2026-10-03).** knext has an opt-in platform layer — a
  > cluster-scoped `KnextPlatform` config the operator reads — that bakes in measured runtime and
  > cold-start defaults for Next.js apps on Knative (image prewarm policy, optional image mirror,
  > read-only `doctor` checks, scaling/resource defaults). It is not general app hosting. Three
  > rules apply **together**:
  > (1) the platform never installs or provisions a database, pooler, cache server, CDN, ingress,
  > gateway, or any general app-hosting component (non-Next workloads, arbitrary containers);
  > (2) every platform field or component must change how a `NextApp` starts or serves;
  > (3) any component beyond the prewarm policy, the optional image mirror with its node agent, and
  > the read-only `doctor` checks needs its own ADR before it ships, even if it passes (1) and (2).

  **`CLAUDE.md` §10**, replace "stay the narrow Next.js+Knative adapter, not a general PaaS" with:
  > stay the narrow Next.js+Knative adapter, not a general PaaS (the ADR-0064 platform layer is
  > opinionated defaults for that adapter, not general hosting)

- **A2 — `.claude/rules/architecture.md` §4**, new bullet:
  > - **Platform defaults go through `KnextPlatform` (ADR-0064).** Cluster-wide defaults and
  >   cold-start components are fields of the cluster-scoped `KnextPlatform` CR, read by the
  >   operator and merged at render time with precedence app > platform > built-in. An absent or
  >   empty CR must render byte-identically to the built-ins (zero-diff guard). A platform default
  >   changes only with a cited measurement.

- **A3 — `.claude/rules/scs-zones.md`**, "knext owns today" bullet, append:
  > …and, through the opt-in platform layer (ADR-0064), the image prewarm policy and an optional
  > in-cluster image mirror. Other cluster-wide components stay out of core.

- **A4 — ADR-0001**, append under Consequences:
  > **Platform layer (ADR-0064).** The operator also reads the cluster-scoped `KnextPlatform` and
  > merges its defaults at render time; it remains the only writer of Kubernetes state. Host-level
  > writes (the optional mirror's node agent) are made only by an operator-owned DaemonSet, bounded
  > to one drop-in per runtime and reverted on removal. Neither the CLI nor any other controller
  > writes `KnextPlatform`-derived state.

- **A5 — ADR-0037**, append to the Decision:
  > **Amended by ADR-0064.** `imagePrewarm` stays off and opt-in per app, and is never on in the
  > default platform profile or when no `KnextPlatform` exists. A cluster admin may enable a capped
  > platform policy (`images.prewarm.mode: selected | all`, bounded by `maxApps`, reported in status).

- **A6 — `.claude/rules/security.md`**, "Runtime hardening", new bullet:
  > - **Platform node agent (ADR-0064).** The only privileged knext workload. Opt-in (exists only
  >   while the image mirror is enabled), least privilege by runtime tier, its own pod-security
  >   `privileged` namespace, in-repo distroless signed image, no ServiceAccount token, egress
  >   denied, path allowlist, reverts host config on removal. A credentialed mirror upstream is
  >   refused unless `NetworkPolicy` enforcement is proven by an active deny probe (an unknown CNI
  >   or an inconclusive probe counts as non-enforcing), or the risk is explicitly acknowledged. The
  >   mirror is pull-only: no push path, no `insecure` HTTP.

- **A7 — ADR-0028**, append to the `containerConcurrency` decision:
  > **Amended by ADR-0064.** The operator default (20) is the built-in layer. A `KnextPlatform` may
  > override it per cluster; an app's own value (including the scaffold's 100) always wins. Whether
  > the scaffold keeps 100 is decided by experiment G3.

- **A8 — `CLAUDE.md` §4**, append to the ADR-0001 bullet:
  > The CLI reads `KnextPlatform` (in `doctor`) but never writes it; the invariant "every CLI
  > cluster write targets the `NextApp` CR" is unchanged by the platform layer.
