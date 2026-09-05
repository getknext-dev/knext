PROCEED — with the shape: `storage` becomes OPTIONAL BY ABSENCE (no `provider: "none"` sentinel), omission is an explicitly-announced deploy mode, and it lands with an ADR (0047) + an amendment note on ADR-0006 and ADR-0011.

# Architect design gate — ergonomics row 3b, `storage` optional (pre-implementation)

Date 2026-08-21 · branch `measure/ux-row3-config-wall` / PR #819 · trigger: `kn-next.config.ts`
schema change (workflow.md escalation trigger #4). Nothing is built; this judges the proposal.

## Verdict summary

The proposal is **subtractive** — it removes a knext-imposed prerequisite and lands the app on
`next start` semantics. It builds no deferred scope, adds no second writer of deployment shape,
adds no new CRD field, and moves knext *toward* the narrow-adapter positioning rather than away.
It is admissible. The risk is not architectural, it is **silent degradation**, and the conditions
below exist to convert that into an announced, tested mode.

## Q1 — Does any hard rule or ADR require the asset-offload path?

**No rule requires it. Two ADRs are materially affected and must be amended, not ignored.**

- **ADR-0008 (app-namespaced assets + deletion finalizer).** No conflict. Its contract is
  *conditional on assets existing in a bucket*. `finalizer.go:130` already guards
  `Spec.Storage != nil && Provider != "" && Bucket != ""` — no-storage teardown is a defined no-op
  today. The `appKeyPrefix` ⇔ `appStoragePrefix` lock-step contract is untouched.
- **ADR-0011 (build-id versioning, retention GC, skew protection).** **Affected, and the lead's
  hypothesis is wrong: in-pod assets are NOT safer for skew — they are strictly weaker.** ADR-0011's
  premise is stated at its Context §1: "assets are served from the durable object store, not
  pod-local disk … a cold/scaled-to-zero pod of build B can still serve build A's chunks." Remove
  the store and that sentence is false. Precisely:
  - **Rollback (ADR-0014) gets SAFER.** A pinned old revision serves assets from its own image, so
    it cannot be reaped by a retention window at all. The `retain=3` over-delete failure class
    disappears. This half of the lead's intuition holds.
  - **In-flight skew gets WEAKER.** A browser holding build A's HTML after traffic moved 100% to B,
    once revision A is scaled to zero and Knative revision-GC'd, requests `_next/static/<A>/…` and
    gets a 404 from a B pod. The object store is exactly what covered that window.
  - **Mitigation already present, and it is partial.** ADR-0011's `deploymentId` half still works
    (build-id lives in the image; `NEXT_DEPLOYMENT_ID` + the `generateBuildId` forcing + the
    `.next/BUILD_ID` deploy guard are all storage-independent), so Next still emits `?dpl=` and the
    skew signal that triggers a client reload. That covers navigations; it does not cover a chunk
    load already in flight. Call this honestly in the ADR and the docs.
  - **GC becomes a no-op**, which is correct — there is nothing to reap. `gc` must say so and exit
    0, not crash and not claim success at reaping.
- **ADR-0006 (image optimization) — the sharpest tension.** Its options table explicitly lists
  "Pod-local cache only — re-optimizes every cold pod, defeats scale-to-zero economics" and
  **Rejects it on correctness grounds**. A storage-less app lands exactly there:
  `image-cache-sync.ts` is already gated on `STORAGE_BUCKET` and returns a null store when unset, so
  the behaviour is *defined and safe* — `next/image` still works via built-in `sharp`; variants just
  don't survive pod death. But this makes an ADR-rejected option the **default for the starter
  path**, and that is a decision, not an implementation detail. It requires an ADR-0006 amendment
  saying so in one paragraph. It is not a blocker: ADR-0006 rejected pod-local as the *mechanism for
  the production data plane*, in a world where storage was mandatory; it did not rule on a
  no-storage tier that did not exist.
- **ADR-0001** — untouched. `cr-builder.ts:273` already emits `storage` conditionally; the CLI still
  writes only the `NextApp` CR; no raw Knative object, no new writer, no out-of-band mutation.
- **Compat suite** — no row in `docs/compat-matrix.md` depends on asset offload. No gate weakens.

## Q2 — Blast radius on operator / CRD: **effectively zero, and this is the strongest argument**

`api/v1alpha1/nextapp_types.go:55` is already `Storage *StorageSpec \`json:"storage,omitempty"\``,
a nillable pointer with no required marker, and **both** consumers are already nil-guarded
(`nextapp_controller.go:1128`, `finalizer.go:130`). An absent `spec.storage` is valid against
**every CRD version ever shipped**, including operators older than the CLI. Under the #547/#548
version-skew rules this is the one field-shape change that carries no skew risk at all: there is no
new field to be pruned or strict-rejected, and no upgrade-ordering constraint. The change is
**CLI-side only** — `config.ts`, `validate.ts`, `loader.ts`, and the consumers listed in Q6.

Corollary worth stating: **the CRD has permitted this since day one; only the CLI forbade it.** The
wall row 3b measured is a validator, not an architecture.

## Q3 — Does in-pod serving break ISR / image optimization? **No.**

- **ISR / data cache is Redis** (`cache-handler.js`, `spec.cache`), a *separate optional* config
  branch from `storage`. Untouched. No-storage + Redis-ISR is a coherent combination; so is
  no-storage + no-cache (in-memory, per-pod — already the existing behaviour when `cache` is
  omitted).
- **Image optimization does not require the bucket.** `sharp` is in the runtime image;
  `/_next/image` works. Only the *cross-pod variant cache* is lost — see the ADR-0006 amendment
  above.
- **Static serving needs nothing new.** `templates/app/Dockerfile.hbs:49-50` already
  `COPY`s `.next/static` and `public` into the image (the file-manager Dockerfile calls it the
  "non-CDN fallback" in a comment). **The in-pod path is not a new runtime path — it is the path
  the image has always been built for.** This is why "don't rewrite the runtime twice" is not in
  play: nothing is rewritten, one wiring step is skipped.

## Q4 — Shape: **optional-by-absence. Reject `storage: { provider: "none" }`.**

| Shape | Old-operator behaviour | Verdict |
|---|---|---|
| **`storage?` absent (chosen)** | Valid on every shipped CRD; both operator consumers already nil-guard; nothing to prune or strict-reject | **Chosen** |
| `provider: "none"` sentinel | A *new value* in a field an old operator forwards verbatim to `STORAGE_PROVIDER` / `GCS_BUCKET_NAME` env. `nextapp_controller.go:1128` gates on `Provider != ""` — `"none"` passes that gate, so an older operator injects `STORAGE_PROVIDER=none, GCS_BUCKET_NAME=""` into the pod: a *silent misconfiguration*, not a rejection | **Reject** |
| Explicit `storage: false` | Same new-value problem plus a type change on an existing field | Reject |

The sentinel is worse on exactly the axis #547/#548 care about: absence is a state every past
operator already understands; a new enum value is a state only the *new* operator understands, and
the failure is silent rather than loud. Design the CLI so **omission is the only way to express it**
— do not also accept a sentinel "for clarity", because two spellings of one state is how the two
validation mirrors drift.

## Q5 — Sequencing (CLAUDE.md §6): **Tier-A-adjacent, not drift.**

It ships no Tier-B/C capability and no deferred scope (no gRPC/ADR-0002, no zones, no CDN, no WAF).
It *deletes* a requirement. The default path's correctness is Tier A, and "the advertised default
path cannot run hello-world without two cloud accounts" is a default-path defect. It also sits under
the founder-set standing ergonomics loop, and CLAUDE.md §2's fame-first strategy is explicitly an
adoption bet. **Positioning (Q4 of the sign-off frame) is a strong pass**: converging on
`next start` semantics is narrow-adapter behaviour; it is the *opposite* of PaaS drift, which would
be knext provisioning the bucket for the user. Do not let a follow-up turn "storage optional" into
"knext provisions storage" — that is the drift line, and it is a different ADR with a different
answer.

## Conditions of this PROCEED (all six; a reviewer may hold the PR on any one)

1. **Announce the mode, every deploy.** Storage-omitted must print, at `info`, that static assets
   are served from the image — no CDN offload, no cross-deploy asset retention, in-flight skew
   window unprotected — with the docs link to the growth path. Rationale: ADR-0043 §3 — narrowing a
   *check* removes coverage silently. A dropped or mistyped `storage` block must not look identical
   to a deliberate choice. `doctor` should report the mode too.
2. **Both validation mirrors, or neither.** `validate.ts:164` and `loader.ts:26` **both** hard-require
   `storage` today. This repo's most frequent defect class is fixing one of two halves
   (`knext-guard-both-halves`); ADR-0040 names the CLI-mirror drift explicitly. A test must fail if
   either site still rejects an absent `storage`.
3. **Every consumer nil-safe with an intentional no-op, not a crash.** Known sites:
   `asset-upload.ts` (`getAssetPrefix:60`, and 184/531/611/762/815/943), `deploy.ts:382`,
   `build.ts:52`, `gc.ts` (must report "no object storage configured — nothing to reap" and exit 0),
   `cleanup.ts`. `preview.ts:315` is already guarded — copy that shape. **Prefer a scan to this
   enumerated list** (workflow.md: an enumerated list of call sites is how the second one gets
   missed) — make `config.storage` non-optional-typed impossible to dereference by typing the field
   optional in `KnativeNextConfig` and letting `tsc` find them all. That is the cheapest complete
   guard available here and it should be the primary one.
4. **A behavioural test, mutation-proved.** A storage-less config must build, deploy, and serve
   `_next/static` with **no** `assetPrefix` in the emitted HTML, and the image must contain
   `.next/static`. Delete the Dockerfile `COPY .next/static` line and watch it go red — a guard that
   stays green when its subject is removed is decoration.
5. **Docs, in the same PR** (workflow.md step 5 — the docs site is dogfooded). `skew-protection.mdx`,
   `rollback.mdx`, `multi-cloud.mdx` and `cli.mdx` all currently state the offload path as
   unconditional; each needs the "with object storage configured" qualifier plus a short "starting
   without storage / when to add it" section. A user-facing guarantee that silently becomes
   conditional is worse than one that never existed. Keep it user-facing per house rule — no ADR or
   issue numbers in the docs site.
6. **`create` scaffolds the no-storage default.** The scaffold should emit `storage` **commented
   out** with the plain-language growth path above it, so the persona's `create → deploy` path has
   one remaining prerequisite (the registry) instead of two. Without this the schema change does not
   actually move row 3b's needle. The registry half is correctly out of scope here.

## ADR to write

**ADR-0047: "Object storage is optional — the in-image static tier."** Context (row 3b's
measurement), Decision (absence is the signal; no sentinel), Options table (the three shapes in Q4),
Consequences (skew window unprotected in-flight but rollback strengthened; image-variant cache goes
pod-local; static traffic now counts against `containerConcurrency` (ADR-0028) and holds pods warm,
which touches the scale-to-zero economics knext sells — negligible for a starter, material at scale,
and the honest reason the offload path exists), Action items (the six conditions). Amend **ADR-0006**
(pod-local variant cache is now reachable by configuration, and is the starter default) and
**ADR-0011** (its Context §1 premise is now conditional; state the two-way skew/rollback result
above). Neither amendment reverses a decision — both record a newly-reachable configuration.
