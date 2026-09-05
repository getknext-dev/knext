# Sprint plan — System Designer half: stability (reliability · security · tech debt)

Scope: the world after ADR-0048 Amendment 3 (PR #890) — **vinext + Bun 1.4 + `bun build --compile
--bytecode` single executable is the only builder**. Everything below is grounded in the tree at
`agent/vinext-only-builder` (HEAD `95bcb91`). Counterpart artifact: `.claude/plan-stability-architect.md`
(strategy/sequencing). This file owns failure modes, reliability, security surfaces, and the debt
inventory.

**The organising observation.** ADR-0048 moved the artifact. It did not move the *evidence*. Nearly
every gate in this repo still proves something about a shape nothing ships — and in three cases the
gate was *repaired to stay green* by repointing it at the last surviving instance of the retired
shape, which is worse than deleting it, because a green check now asserts the opposite of what its
name claims. The recurring pattern in this sprint is not "a thing is broken"; it is **the proof and
the artifact have come apart**.

---

## 1. Runtime reliability of the single-exec path

### 1.1 Nothing on earth SIGTERMs the shipped binary (#887) — **SEV-1**

**Failure mode.** Knative scales the app down. The queue-proxy sends SIGTERM. If
`createGracefulShutdown` misbehaves *when compiled* — the `unref()`'d hardcap timer, the
DO-NOT-REORDER metrics-stop, `srvx.close()`'s waitUntil semantics, or bytecode-frozen module init
order — in-flight requests are dropped on every scale-down. No test in the repo would go red.

**Evidence.**
- The shipped drain is `runtime-contract.mjs.hbs:359-408` (`createGracefulShutdown`), wired at
  `knext-bun-entry.mjs.hbs:247-256`. Grace default 25 000 ms (`knext-bun-entry.mjs.hbs:134`),
  hardcap `s.stop(true)` + `exit(1)`, metrics listener stopped LAST and load-bearing
  (`runtime-contract.mjs.hbs:390-398`).
- The gate that claims to cover it is `ci.yml:346` **`sigterm-drain-shipped`**, whose own header
  still reads *"The image CMD is `node -e import('@getknext/core/internal/node-server')`"*
  (`ci.yml:347-349`) — false since ADR-0048. `apps/file-manager/Dockerfile` CMDs `/app/server`.
- It was kept green by repointing at db-demo: `ci.yml:398` builds `db-demo` and `ci.yml:419` sets
  `KNEXT_SIGTERM_APP_DIR=.../apps/db-demo`, with a comment stating db-demo *"is the only app still
  emitting one [a standalone tree] since ADR-0048"* (`ci.yml:390-396`). `apps/db-demo/package.json:8`
  = `next build --webpack`. So the gate proves `node-server.ts`'s supervisor drains a standalone
  child — a combination that **ships in zero images**.
- The nearest thing to real coverage is `examples/bun-exec/test/sigterm-hardcap-e2e.test.ts`, and it
  is two removes from the artifact: it asserts drain **ordering by reading `runtime-contract.mjs` as
  source text** (`:71-79`, `shutdownBody.indexOf('await drainTasks()')`), and it spawns
  `srvx-close-harness.mjs` / `drain-harness.mjs` under plain `bun`. The container e2e itself concedes
  the gap: `examples/bun-exec/test/alpine-image.docker-e2e.test.ts:286` — *"the drain/metrics
  harnesses MIRROR the entry rather than import it"*. That file boots the real compiled binary in a
  container (`:223`, `:232`) and asserts health, SSR, static assets, CSS modules — **and never sends
  a signal**. Zero `SIGTERM` hits in it.

**Net:** `security.md`'s "Graceful shutdown … drain in-flight requests … no dropped requests on
scale-down" is a hard rule whose only live evidence is a text-order assertion plus a mirror.

**Smallest sound fix.** Extend the *existing* container e2e rather than writing a new lane —
`alpine-image.docker-e2e.test.ts` already has a booted binary, a known port and a `docker run`
lifecycle. Add: hold a slow request open → `docker kill --signal=TERM` → assert (a) the held request
returns 200 with its full body, (b) the container exits 0, (c) `DRAINED cleanly` in logs; plus a
second case with a never-resolving route asserting exit 1 and `HARDCAP`.
**Exit criteria.** Mutation-proved: replace `s.stop()` with `s.stop(true)` in
`runtime-contract.mjs.hbs` and the drain case must go red; delete the hardcap `setTimeout` and the
hardcap case must go red. Both via a script that asserts its anchor occurs exactly once
(`workflow.md`: never `perl`). The db-demo-backed `sigterm-drain-shipped` job is then either renamed
to what it actually gates (`sigterm-drain-node-server`) or deleted with db-demo.

### 1.2 Readiness is app-owned with no floor (#894) — **SEV-1**

**Failure mode.** The operator's readiness *and* liveness probes default to `/api/health`. Nothing in
the entry serves it — `knext-bun-entry.mjs.hbs` and `runtime-contract.mjs.hbs` register no route;
`runtime-contract.mjs.hbs:27-30` says item 1 (health) is "covered by the sample app routes". An app
that renames, deletes, or breaks `app/api/health/route.ts` compiles cleanly, pushes cleanly, and the
revision **never goes Ready**. Scale-from-zero then never completes and every request 503s at the
activator. The failure surfaces on a cluster, minutes after a green build.

**Evidence.** Health exists only as app code (`examples/bun-exec/app/api/health/route.ts`). The entry
merely *fetches* `/api/health` for warmup (`knext-bun-entry.mjs.hbs:226-244`) and **swallows the
error** (`WARMED:${path} status=error`), so even the one code path that touches it is fail-open.
`buildVinextExecutable` compiles `.output/server/index.mjs` whatever it contains
(`vinext-build.ts:176-191`).

**Smallest sound fix.** The post-compile smoke of #894, scoped tightly: after
`bun build --compile`, boot the binary once on an ephemeral port, assert it prints
`LISTENING:<port> METRICS:<port>` (`knext-bun-entry.mjs.hbs:199`), answers the *configured*
`readinessProbePath`, serves `:METRICS_PORT/metrics`, and exits 0 on SIGTERM within grace. Fail the
build naming the missing obligation. Cross-arch caveat is real (`--target=linux-x64` on a darwin
host): build a host-arch smoke binary for the smoke only, and make `--skip-runtime-smoke` LOUD.
**Exit criteria.** Deleting the health route from the scaffold fails `kn-next build` with a message
naming health; deleting the drain fails it naming drain. This subsumes 1.1's obligations at build
time — but does **not** replace 1.1, which is the only thing that proves drain *behaviour under
load*, not mere presence.

### 1.3 ISR is dead in the scaffold, and broken in the reference app (#886) — **SEV-1**

Two distinct defects that #886 currently conflates. Separating them is most of the fix.

**(a) Reference app — handler registered, route never written.** `apps/file-manager/next.config.ts:34`
*does* set `cacheHandler`, and compat-smoke logs `Registered Custom CacheHandler via setCacheHandler`.
Other routes SET fine; `unstable_cache` HITs. Only `/knext-smoke/isr` MISSes twice and never SETs.
Fixture is `export const revalidate = 1`. Conclusion: **vinext does not translate the
`revalidate` route-segment export**, so the route is served dynamically and no write is ever
attempted — an upstream-shaped defect, not a client bug (three real Redis client bugs were fixed and
this survived all of them, and it fails identically on a leg that never touched the native client).

**(b) Scaffold — no cache handler at all. Unfiled, and broader.**
`packages/kn-next/templates/app/next.config.ts.hbs` has **zero** `cacheHandler` /
`cacheMaxMemorySize` (verified: grep returns nothing; the template sets only `assetPrefix` at
`:33-35`), and the template directory ships no `cache-handler.js`. So every app produced by
`kn-next create` has no ISR/data cache whatsoever — not Redis, not the in-memory default — and
nothing warns. The reference app got its wiring by hand and the scaffold never inherited it.

**Failure mode (b), concretely.** User scaffolds an app, adds `revalidate = 60`, deploys behind
Knative with `containerConcurrency` and scale-to-zero. Every request full-renders. Under scale-from-
zero every cold pod re-renders everything. The user sees "ISR doesn't work on knext" with no error
anywhere — it is silent, and it is the default path.

**Severity split.** (b) is SEV-1 and knext-owned. (a) is SEV-2 *because it is partly upstream* — but
it is the one currently reddening `compat-smoke`, which per `CLAUDE.md` §9 has no skip mechanism, so
it is also a blocked lane.

**Smallest sound fix.** (b): put `cacheHandler` in the scaffold template pointing at the shipped
`@getknext/core/adapters/cache-handler` shim, with `cacheMaxMemorySize: 0` matching the reference
app; scaffold test asserts the generated `next.config.ts` sets it. (a): reproduce minimally outside
knext (a bare vinext app with `revalidate`), then either land a vinext-side fix or record the
uncovered surface in `docs/compat-matrix.md` **as a red-on-fail row that stays red** — never a skip.
**Exit criteria.** (b) removing `cacheHandler` from the template reds the scaffold test; a
scaffold-and-build integration asserts a `revalidate` route produces a SET. (a) `compat-smoke` check
(k) green, or the row is documented red with an issue link and the matrix is the source of truth.

### 1.4 The seam guard protects a bug class the artifact cannot have (#885) — **SEV-2, and it is red**

**Current state: a hard-failing CI job.** `scripts/seam-alive-apps.mjs` returns `["file-manager"]`
(verified by running it). `ci.yml:518` builds it with `bun run --filter ./apps/file-manager build` =
`vite build` (`apps/file-manager/package.json:8`), which emits `.output/`, never
`.next/standalone/apps/file-manager/.next/server` (`standalone-seam-alive.test.ts:51`). With
`KNEXT_REQUIRE_STANDALONE: '1'` (`ci.yml:522`) `buildPresent` is false and the first `it` throws
(`standalone-seam-alive.test.ts:139-147`). Red, deterministically.

**The substantive point, which a path fix would bury.** #352 was *webpack-layer duplication* — Next
duplicating `@getknext/lib` across layers, giving each copy independent module state. vinext/rollup
with `inlineDynamicImports` has no webpack layers. The issue's own measurement found all four seam
symbols present exactly once in one bundle, and correctly calls that *"suggestive, not conclusive:
one occurrence of the KEY is not the same as one physical copy of the MODULE."* Meanwhile
`architecture.md` names this guard **mandatory by file path** — so quietly repointing it is an
undocumented amendment to a hard rule, i.e. exactly the escalation trigger `workflow.md` describes.

**Smallest sound fix.** Do not repoint. Decide, and record it: the guard's *subject* is "seam state
is not duplicated in the shipped bundle", and the shipped bundle is now the compiled binary. Rewrite
it to assert on `.output/server/index.mjs` **plus** the compiled binary — counting distinct physical
module records, not key occurrences (e.g. inject a counter into the seam module and assert it
initialises once at runtime, which is the only formulation that survives bundler changes). Amend
`architecture.md`'s file-path citation in the same PR. Keep db-demo's copy running the webpack
assertion for as long as db-demo exists.
**Exit criteria.** Mutation-proved by replacing one `Symbol.for('knext.lib.*')` with a module-level
`let` and watching it red — the check `architecture.md` actually cares about.

### 1.5 `.output/server/index.mjs` under bun ≠ the compiled binary — **SEV-2**

`compat-smoke` boots `bun .output/server/index.mjs` (`ci.yml:340`), not the artifact. The whole
`runtime-contract.mjs:110,156-189` asset-root resolver exists *because* the compiled binary's baked
root is the build machine's tree and must be re-derived at runtime; `sharp` needs a `dlopen` shim for
the same reason (`vinext-compile.mjs:26-43,113-136`). Every one of those divergences is invisible to
compat-smoke. The alpine container e2e covers them — for `examples/bun-exec` only, not for the
reference app, and not for a scaffolded app.
**Fix:** fold the compiled-binary boot into the scaffold's own e2e (rides on 1.2's smoke), so
"scaffolded app → compiled binary → serves" is proven once per PR.

---

## 2. Data plane

### 2.1 Asset storage grows without bound under vinext (#892) — **SEV-2**

**Failure mode.** Deploy N times with `storage` configured → N generations of assets, forever. GC can
never reap any of them. Cost grows linearly with deploy count and is invisible until a bill.

**Evidence.** `pruneOldBuilds` (`asset-upload.ts:1046-1150`) uses **marker inversion**: only a prefix
carrying `<id>/.knext-build` (`BUILD_MARKER_FILENAME`, `:689`) is a reap candidate; everything else
goes to `summary.keptUnmarked` (`:1078-1093`). `stageStandaloneAssets` writes the marker off
`.next/BUILD_ID` (`:539-566`). `stageNitroPublicAssets` deliberately does not (`:590-597`) and warns
on every deploy (`:622-626`). Two compounding leaks: (i) each deploy mints a fresh unmarked
`_next/static/<uuid>/`; (ii) `chunks/`/`css/`/`media/` are in `RESERVED_STATIC_DIRS` (`:670-676`) so
they are **never** prune candidates under any builder, and vinext content-hashes every file into
them, while all provider uploads are additive-only (no `--delete`, `:242-470`).

**Judgement: the deferral was right, the framing is not.** Fail-safe over-keep is correct under
ADR-0011 (never over-delete). But this is now the *only* path, so "tracked follow-up" understates it.
**Smallest sound fix.** Thread the vinext static id (the uuid the nitro build emits) back to the
staging step and mark *that* prefix, and teach `classifyBuilds`' live-traffic protection to resolve
the same id from the revision label. Leave `RESERVED_STATIC_DIRS` alone (that is a separate,
larger problem — hashed flat dirs need a reachability sweep, not a prune).
**Exit criteria.** A red-first test that stages a vinext artifact, runs `gc`, and asserts the current
build's prefix is *protected* and a prior one is reaped. Over-delete must be the thing the test is
built to catch.

### 2.2 Failed-push reclaim silently no-ops on the only build path — **SEV-2**

`deploy.ts:570` calls `reclaimBuildPrefix(config, buildId)` in the upload-succeeded/push-failed leg;
`buildId` is the deploy tag (`deploy.ts:398-399`). It deletes `<app>/_next/static/<deployTag>/`
(`staticBuildDeleteUri`, `asset-upload.ts:921-939`). Under vinext the assets live at
`_next/static/<nitro-uuid>/` + flat `chunks/`/`css/`. The delete targets a prefix that was never
written; `runQuietAllowFail` swallows it; the run logs *"Reclaiming orphaned asset prefix…"*
(`:981-986`) having reclaimed nothing. **A failed deploy now permanently orphans its assets and
reports success at cleaning up.** The false log line is the worst part — it will defeat the next
person who investigates. Same root cause as 2.1 (no vinext build identity); fix together.

### 2.3 Skew protection is inert under vinext — **SEV-2, currently masked**

`deploy.ts:437-462`'s BUILD_ID lock-step guard tolerates `ENOENT` and warns
(*"skipping build-id lock-step check"*, `:459-461`). vinext never writes `.next/BUILD_ID`, so the
guard is skipped on **every** deploy. `next.config.ts.hbs` sets no `deploymentId`, and `cr-builder.ts`
never injects `NEXT_DEPLOYMENT_ID` into the container env (only user `config.env`, `:310`) — so even
though vinext supports `deploymentId` at the library level, knext never activates it. No `?dpl=`,
no skew detection.

**Why it hasn't bitten, and why that is the danger.** vinext content-hashes chunks and CSS, and
nothing ever reaps them (2.1). So an old client's hashed URLs still resolve. **Today's safety is a
side effect of the GC gap.** Fixing 2.1 *removes* it. That is a genuine dependency edge, not a
theoretical one — and the per-build `_buildManifest.js`/`_ssgManifest.js` under the uuid dir is
build-specific and has no `?dpl=` cross-check even now.
**Smallest sound fix.** Set `deploymentId` in the scaffold's `next.config` from an env var and inject
that env var into the CR container. **Land it before 2.1**, not after.

---

## 3. Security of the new artifact

### 3.1 The shipped image's JS closure is scanned by nothing — **SEV-1**

**Failure mode.** A HIGH/CRITICAL CVE lands in React/Next/vinext/nitro or any transitive dep. It is
compiled into the binary. Trivy reads the image and sees an Alpine package DB and one ~100 MB opaque
blob. The gate passes. The image is pushed, cosign-signed, and SBOM-attested — **attesting the
vacuous SBOM**.

**Evidence.** `supply-chain.yml:107-116` runs `anchore/sbom-action` over `oci-dir:image-oci-sbom` —
the built image, not a pre-compile tree — and `:124-131` runs the Trivy gate over the same. That
SBOM is then the attestation predicate at `:222-223`. ADR-0042 C6 anticipated exactly this
(`0042:263-270`: *"a `bun --compile` binary is opaque to Trivy and syft"*) and built
`vinext-precompile-closure` (`ci.yml:1219-1279`) — but its subject is **`examples/bun-exec` only**,
and `tests/precompile-closure-gate-ci.test.ts:45-46` states so verbatim: *"A USER app built on the
vinext target has no equivalent gate."* The `vinextArtifactJobs` recognizer only flags jobs that
textually mention `examples/bun-exec`, so `prod-image-optimization` (`ci.yml:740-790`) and
`image-supply-chain` (`supply-chain.yml:67-72`) — the jobs that build and publish the real image —
are invisible to it and carry no `needs:`. The comment asserting *"NO VINEXT IMAGE IS PUBLISHED FROM
CI TODAY"* (`ci.yml:1191-1193`) predates ADR-0048 and is now **false**: `supply-chain.yml:176`
pushes to GHCR on `main`.

**This is a `security.md` invariant failing, not a nice-to-have.** "SBOM per image · scan every
image · fail on HIGH/CRITICAL" is satisfied only at a layer that, for this artifact shape, is empty.

**Smallest sound fix.** Two edits, both small: (1) generate the closure SBOM from the pre-compile
tree *inside* the real build lane and make it the `cosign attest` predicate — this is the owed half
of #785 and it is now unblocked, because a publish lane **exists** (the tracked reasoning that it
does not is stale); (2) fix the recognizer to key on "runs `vinext-compile`" rather than on the
string `examples/bun-exec`, so the production jobs are caught by construction.
**Exit criteria.** `prod-image-optimization` and `image-supply-chain` both `needs:` a closure audit of
*their own* tree. Mutation-proof: introduce a known-vulnerable pinned dep into the reference app's
closure and watch the gate red. The recognizer must fail when a new compile job is added without the
`needs:` — prove it by adding one.

### 3.2 `native/` ships unverified native code — **SEV-2**

`stageSharpNative` (`vinext-build.ts:217-226`) does `cpSync(source, dest, {recursive:true,
dereference:true})` over whatever is under `node_modules/@img`, with no hash, allowlist, or
signature; `findImgPackages` (`:229-238`) copies everything it finds. `Dockerfile.hbs:54`
`COPY native /app/native` verbatim. The binary `dlopen`s it at request time. A poisoned
`@img/sharp-linux-x64` prebuilt propagates end-to-end with no gate — and because `.node` files are
opaque blobs, an SBOM that lists the *package* still cannot detect a swapped addon.
**Smallest sound fix.** Record the resolved integrity hashes from `bun.lock` for the `@img` packages
at stage time and fail the build if a copied file's digest is not the one the lockfile pinned. Cheap,
and it converts "we copied whatever was there" into "we copied what the lockfile said".

### 3.3 No request-body cap anywhere in the shipped runtime (#743) — **SEV-2**

`knext-bun-entry.mjs.hbs:148-165`'s `serve({...})` passes no `maxRequestBodySize`; the only middleware
counts in-flight requests. `runtime-contract.mjs.hbs` has no body-limit symbol at all.
`docs/security/threat-model.md:187` states it plainly: *"Route handlers have no body cap … one
oversized body OOMKills one pod … OPEN."* The only controls are documented recipes
(`hardening.mdx:35-58`, whose own table lists body size, request rate and slow-clients as
unbounded), and the reverse proxy binds only the external path — not the in-cluster
NetworkPolicy-bypass path.

**The deferral's clock cannot fire, and that is now a design fact.** ADR-0044 Option C is deferred
with a hard expiry at "Tier-A exit or v1.0", and `0044:201-211` records that the expiry is blocked on
an undefined Tier-A exit — *"an expiry anchored to an undefined event cannot fire, so as written this
exception renews forever."* #742 (which was to define it) is **CLOSED**. So either the expiry now has
an anchor and Option C is due, or the exception is unbounded — and an unbounded exception to a
security control is not an exception, it is a decision.

**Additionally, Option C's stated blocker is gone.** `0044:121-122` deferred it until "the runtime
that owns the port is settled". ADR-0048 settled it. There is now exactly one port owner
(`knext-bun-entry.mjs.hbs`), which is the cheapest place this cap will ever be.
**Smallest sound fix.** A counted-bytes cap in the entry's existing middleware — it already wraps
every request — with the limit read from a documented env var and a 413 on breach. Escalation
trigger: this touches the RuntimeContract and a security invariant, so it goes to the architect gate,
not to a team's own judgement.

### 3.4 Correctly closed — do not re-file

- **#744 NetworkPolicy inert on flannel: has a signal, contrary to the issue title.**
  `netpol_enforcement.go:54` sets `ConditionNetworkPolicyEnforced` with three-valued detection
  (`:68-82`, DaemonSet signature match at `:114-128`), wired at `nextapp_controller.go:633-642`; the
  CLI mirrors it (`doctor.ts:599-660`, check at `:1178-1268`) with explicit "enforces NOTHING on this
  cluster" wording (`:1246-1249`); documented at `hardening.mdx:25-30`. **Close #744 as done** rather
  than scheduling it.
- **The PR #890 r2 residual is fixed, and with the better fix.** `stageNitroPublicAssets` now stages
  into `mkdtempSync(join(tmpdir(), "knext-upload-"))` (`asset-upload.ts:619`), outside the build
  context by construction — so no `.dockerignore`/`.gitignore` entry is needed. The inherited
  `.dockerignore.hbs` defect is also fixed: `!.output/public` and `!knext-exec-linux-*` are present.
- **#794 imagePullSecrets** is a real but narrow gap: no CRD field; the operator's SA
  (`nextapp_controller.go:395-411`) never sets `.ImagePullSecrets` and never clobbers a manual one,
  and the prewarmer reads it back (`image_prewarm.go:240-246`). Private-registry users must patch the
  SA out-of-band. Feature work, not a stability defect — schedule after the SEV-1s.

---

## 4. Test & guard debt

### 4.1 The coverage gate measures 3 files out of 338 (#884) — **SEV-1 for the gate, not for users**

Vitest collects 3 files post-migration; the gate reports 1.37% against a 77% global floor and a 90%
`packages/kn-next/src/**` floor (`vitest.config.ts:147-167`). The bun runner cannot take over as-is:
`scripts/bun-test.mjs` spawns one process per file (deliberately — ~55 files need per-file mock
isolation), `--coverage` is pushed into the per-file spawn (`:166`) so each file emits its own report,
and bun's thresholds have no per-path form.

**Recommendation: option A (merge lcov across both runners), and reject C.** Parking the gate leaves
thresholds describing a measurement nobody makes, which is this repo's own definition of decoration.
B silently drops the 55 mocking-heavy files, re-creating the dishonest denominator this gate was
built to fix. A costs a merge step plus a threshold checker that is no longer vitest's — that is the
honest price.
**Hard constraint:** dropping `--coverage` to go green is out of bounds. Also fix
`bun-test.mjs`'s docstring, which currently claims the opposite of what the code does.

### 4.2 Guards asserting a retired shape — full enumeration

Scanned `packages/**/__tests__`, `tests/`, `apps/**/*.test.ts`, `scripts/`, `.github/workflows/`.

| File:line | Asserts | Class |
|---|---|---|
| `apps/file-manager/standalone-seam-alive.test.ts:51,139-147` | seam symbols in `.next/standalone` chunks | **BROKEN — red CI job** (§1.4) |
| `ci.yml:346` `sigterm-drain-shipped` (+ `:390-419`) | node-server supervisor drain, repointed at db-demo | **MISNAMED — green, gates nothing shipped** (§1.1) |
| `apps/file-manager/node-compile-cache.test.ts:19-77` | `NODE_COMPILE_CACHE` populates from standalone `server.js` | **DEAD** — self-skips permanently; not referenced in `ci.yml` |
| `apps/file-manager/bun-portability.test.ts:24-57` | bun serves standalone `server.js` | **DEAD** — same, `serverExists` now always false |
| `apps/file-manager/scripts/compat-smoke.mjs:54` | default `SERVER_PATH` = standalone `server.js` | **DEAD default** — overridden at `ci.yml:340`; stale literal |
| `apps/docs/DEPLOY.md:29-36`, `.claude/rules/security.md:35`, ADR-0035/0042 | instruct vendoring `scripts/warm-compile-cache.sh` | **DANGLING** — the script does not exist on disk |
| `packages/kn-next/src/cli/validate.ts:56` | comment "with only `turbopack` available today" | stale comment |
| compile-cache-health / shadow / bun-transpiler suites | `NODE_COMPILE_CACHE` diagnostics in `node-server.ts` | **VALID** — `node-server.ts:22-23` still imports them |
| `artifact-contract*.test.ts`, `build-artifact-resolution.test.ts:50-52` | `turbopack` described, `available:false` | **VALID** — intentional migration messaging |
| `create-scaffold.test.ts:356-405`, `optional-storage.test.ts:332-337`, `dockerfile.test.ts:108-118`, `install-smoke.mjs:494-569` | *absence* of the retired shape | **VALID** — keep |

**`node-server.ts` is not dead and should not be deleted this sprint.** It is exported at
`package.json:64-67` (`./internal/node-server`), built at `tsup.config.ts:70,125`, and is db-demo's
runtime. It is the back-compat path for pre-ADR-0048 CRs.

**`apps/db-demo` is the last living instance of the retired shape** (`package.json:8-9`) and three
gates now lean on it. That is load-bearing debt: whoever migrates db-demo silently deletes the only
evidence behind those gates. Record it as a coupling, and fix §1.1 *before* migrating db-demo.

### 4.3 #871 / #880 / #639 — carry, don't schedule

#871 (74 vitest-bound files) is the parent of #884 and paced by it. #880 (fixture leakage into the
repo root) is noise-class. #639 (guards asserting half a scan) is a rules amendment, and this
sprint's inventory is fresh evidence for it — §1.1, §1.4 and §3.1 are each a guard whose *other half*
(the artifact) moved without the assertion following. Feed the evidence to #639; don't open a
workstream.

---

## 5. Observability

### 5.1 Every app dashboard and app alert references metrics the binary never emits — **SEV-1**

**Failure mode.** The scrape wiring is *correct* — `app-podmonitor.yaml:38-44` targets port 9091 path
`/metrics`, the operator stamps the same annotations (`nextapp_controller.go:849-851`), and the binary
serves exactly that (`knext-bun-entry.mjs.hbs:181-194`). The **metric names** are the drift. A PromQL
query for a name nobody emits returns an empty series, `for:` never satisfies, and the alert never
fires — silently, indefinitely. That is the mechanism behind #792's five dark weeks, and it is now
repo-wide rather than confined to `scale-zero-pg`.

**The contract collapsed from dozens of series to four**, with **zero name overlap** (`kn_next_*` /
`knext_*` → `knext_bunexec_*`) and **no labels at all**:
`knext_bunexec_{process_resident_memory_bytes, process_uptime_seconds, http_requests_total,
http_inflight_requests}` (`runtime-contract.mjs.hbs:252-271`).

Broken: `bytecode.json` (100%), `red-overview.json` (100%), `rum.json` (100% — the binary has no
web-vitals path at all), `scale-to-zero.json` (all app-emitted series), `loadtesting.json`; and
`prometheusrule.yaml` group `knext.app` — **all four alerts**. Two of them (`KnextHighErrorRate`,
`KnextCacheUnreachable`) cannot be fixed by renaming, because they filter on `status_class` and
`route` labels the new counter does not carry. Unaffected: group `knext.operator` (operator-binary
metrics, `metrics.go:30,39,48,69`) and `KnextNextAppDegraded` (KSM-sourced).

**There is no `up == 0` / `absent()` rule for app targets** anywhere in
`config/observability/prometheusrule.yaml` — while `packages/scale-zero-pg/deploy/60-prometheus.yaml:265`
does exactly that for kube-state-metrics and `scale-zero-pg/docs/operations.md:104` documents the
`*StaleAbsent` companion pattern. The discipline exists in this repo and was never applied to the
rules that needed it most.

**Smallest sound fix, in this order.**
1. **Add the `absent()`/`up==0` staleness companion first.** It is a handful of lines, it is the
   thing that would have caught all of this, and it keeps catching the next one. Do this before
   fixing a single dashboard.
2. Decide the RED contract deliberately: `knext_bunexec_http_requests_total` with no `status_class`
   and no route, plus no duration histogram, means knext currently **cannot compute an error rate or
   a latency SLO**. That is a capability regression, not a naming problem. Add `status_class` (and a
   duration histogram) to the entry's middleware — it already wraps every request
   (`knext-bun-entry.mjs.hbs:154-164`), so this is cheap exactly once, now.
3. Then re-point dashboards, and delete the ones whose subject is gone (`bytecode.json` measures a
   caching strategy the binary does not use; `rum.json` measures a collection path that no longer
   exists). Deleting a dashboard is a legitimate outcome — leaving a blank one is not.
**Exit criteria.** A CI check that extracts every metric name referenced by `config/grafana/**` and
`prometheusrule.yaml` and asserts each is either emitted by the operator's registry or by
`runtime-contract.mjs.hbs`'s `renderMetrics`. Mutation-proof: rename one emitted metric and watch it
red. That converts "someone will notice the dashboard is blank" into a gate.

---

## 6. Tech-debt inventory

| # | Item | Evidence | Cost of carry | Cheapest closure |
|---|---|---|---|---|
| D1 | Shipped binary's drain is untested | `ci.yml:347-349,390-419`; `alpine-image.docker-e2e.test.ts:286` | Dropped requests on every scale-down, undetectable; violates a `security.md` hard rule | Add TERM case to the existing container e2e (§1.1) |
| D2 | Readiness/metrics/drain are app-owned, unverified | `runtime-contract.mjs.hbs:27-30`; `vinext-build.ts:176-191` | Broken app never goes Ready; failure lands on a cluster, not in a build | Post-compile smoke (#894) |
| D3 | Scaffold ships **no** cache handler | `next.config.ts.hbs` (no `cacheHandler`) | Every user app silently has no ISR/data cache | Add to template + scaffold test |
| D4 | vinext drops `export const revalidate` | #886; compat-smoke check (k) red on both legs | A red compat lane; a parity claim knext cannot make | Minimal upstream repro; else a red matrix row |
| D5 | Seam guard red + subject retired | `standalone-seam-alive.test.ts:51,139-147`; `ci.yml:518` | Red CI; a hard rule cites a guard that cannot run | Rewrite against the binary; amend `architecture.md` (§1.4) |
| D6 | GC blind to vinext namespace | `asset-upload.ts:590-597,622-626,1078-1093` | Storage grows linearly with deploys, forever | Thread the vinext static id into marker + protection |
| D7 | `reclaimBuildPrefix` no-ops and says it worked | `deploy.ts:570`; `asset-upload.ts:921-939,981-986` | Orphaned objects + a log line that misleads the next investigator | Same identity fix as D6 |
| D8 | Skew protection inert; masked by D6 | `deploy.ts:459-461`; `cr-builder.ts:310` | Chunk 404s become live the moment D6 lands | Set `deploymentId`; inject env into the CR — **before** D6 |
| D9 | Production image's JS closure unscanned | `supply-chain.yml:107-131,222-223`; `ci.yml:1191-1193` (stale); `precompile-closure-gate-ci.test.ts:45-46` | A `security.md` invariant silently unmet; a signed attestation asserting nothing | Closure SBOM in the real lane; recognizer keys on `vinext-compile` |
| D10 | `native/` copied with no integrity check | `vinext-build.ts:217-238`; `Dockerfile.hbs:54` | Poisoned addon ships and `dlopen`s, invisible to every gate | Verify digests against `bun.lock` at stage time |
| D11 | No request-body cap; exception cannot expire | `knext-bun-entry.mjs.hbs:148-165`; `threat-model.md:187`; `0044:201-211`; #742 **closed** | One oversized body OOMKills a pod; an unbounded security exception | Counted-bytes cap in the existing middleware |
| D12 | Coverage gate measures 3/338 | `vitest.config.ts:147-167`; #884 | The repo's headline quality gate is decoration | Merge lcov across runners (option A) |
| D13 | Dashboards/alerts reference dead metrics; no `absent()` | `prometheusrule.yaml` (`knext.app`); vs `runtime-contract.mjs.hbs:252-271` | Alerts that can never fire; blind operation | `absent()` companion FIRST, then re-point |
| D14 | Binary emits no `status_class`/route/duration | `runtime-contract.mjs.hbs:252-271` | No error-rate or latency SLO is computable at all | Extend the existing middleware |
| D15 | Dead/self-skipping standalone tests | `node-compile-cache.test.ts`, `bun-portability.test.ts`, `compat-smoke.mjs:54` | Green checks that assert nothing; hide the real gap | Delete or repoint with the D1/D5 work |
| D16 | Dangling `warm-compile-cache.sh` references | `apps/docs/DEPLOY.md:29-36`; `security.md:35`; ADR-0035/0042 | Docs instruct vendoring a file that does not exist | Doc edit (`security.md` is maintainer-owned — flag, don't edit) |
| D17 | db-demo is the last standalone app, and 3 gates lean on it | `apps/db-demo/package.json:8-9`; `ci.yml:390-396` | Migrating it silently deletes the evidence behind those gates | Record the coupling; fix D1 before migrating |
| D18 | `#744` closable as done | `netpol_enforcement.go:54-128`; `doctor.ts:1178-1268` | Sprint capacity spent re-verifying a closed gap | Close the issue |
| D19 | No CRD field for `imagePullSecrets` | `nextapp_controller.go:395-411`; #794 | Private-registry users patch an operator-owned SA out-of-band | CRD field; feature work, after the SEV-1s |

---

## 7. Dependency edges and blast radius

```
D8 (deploymentId / skew)  ──must land before──▶  D6 (GC learns vinext) ──▶ D7 (reclaim)
        │                                              ▲
        │  D6 currently MASKS D8: nothing is reaped,   │  shared prerequisite:
        │  so stale chunks stay resolvable.            │  a vinext build identity
        └──────────────────────────────────────────────┘

D2 (post-compile smoke) ──enables──▶ D1 (drain e2e)   [smoke gives a booted binary + port harness]
D1 ──must land before──▶ D17 (migrating db-demo)      [db-demo is the current gate's only subject]
D5 (seam rewrite) ──requires──▶ architecture.md amendment  [same PR, else it is a quiet rule change]
D13 (absent() rule) ──must land before──▶ D14/dashboards  [the guard first, then the thing it guards]
D12 (coverage) ──gates──▶ #871 completion             [vitest cannot be removed until coverage moves]
D9 (closure SBOM) ──independent──▶ but shares the build lane with D2; sequence to avoid file conflict
```

**Blast radius (for parallel-team assignment; `workflow.md` requires disjoint files):**

| Fix | Files held | Radius |
|---|---|---|
| D1 | `examples/bun-exec/test/alpine-image.docker-e2e.test.ts`, `ci.yml` (one job) | Small; CI-only |
| D2 | `cli/{build,vinext-build}.ts`, templates, `ci.yml` | **Medium — touches the CLI surface ⇒ mechanically-detected escalation trigger** |
| D3 | `templates/app/next.config.ts.hbs`, `create-scaffold.test.ts` | Small, but changes every generated app ⇒ public-surface-adjacent |
| D5 | `apps/file-manager/standalone-seam-alive.test.ts`, `.claude/rules/architecture.md` | **Trigger: amends a hard rule ⇒ architect gate** |
| D6+D7+D8 | `utils/asset-upload.ts`, `cli/deploy.ts`, `cr-builder.ts`, `next.config.ts.hbs` | **Large; one team only. D8 also touches the CR wire ⇒ trigger** |
| D9 | `supply-chain.yml`, `ci.yml`, `tests/helpers/vinext-artifact-scan.ts` | Medium; **security invariant ⇒ trigger** |
| D11 | `knext-bun-entry.mjs.hbs`, `runtime-contract.mjs.hbs` | **Trigger: RuntimeContract + security invariant ⇒ architect gate** |
| D12 | `vitest.config.ts`, `scripts/bun-test.mjs`, `ci.yml` | Medium; conflicts with **every** other team's `ci.yml` edit — **serialise `ci.yml` through one owner** |
| D13+D14 | `config/observability/prometheusrule.yaml`, `config/grafana/**`, `runtime-contract.mjs.hbs` | Medium; D14 collides with D11 on `runtime-contract.mjs.hbs` — **same team or sequence** |

**Two contention points worth stating plainly.** `ci.yml` is touched by at least six of these; two
teams editing it concurrently is the file-overlap `workflow.md` forbids, so one team owns it and the
others hand it patches. And `runtime-contract.mjs.hbs` is held by D11 and D14 — the body cap and the
metrics labels both live in the same middleware. Give them to one team.

---

## 8. The three things I would refuse to ship v1.0 without

**1. Proof that the shipped binary drains on SIGTERM.** (D1, then D2.)
Graceful shutdown is a `security.md` hard rule. Today the evidence is a string-index assertion on a
template's source text and a harness that mirrors the entry rather than being it — and the job named
`sigterm-drain-shipped` gates a runtime that ships in no image. Every scale-to-zero cycle is a
SIGTERM, and scale-to-zero is the entire product thesis. This is the one where the gap and the
positioning point at exactly the same code path. It is also cheap: the container e2e already boots
the binary and holds a port; this is a signal and two assertions.

**2. A supply-chain gate that can see the production image's dependencies.** (D9.)
The image is pushed, signed, and SBOM-attested — and the attested SBOM describes an Alpine package DB
next to an opaque blob. A signed attestation that asserts nothing is worse than no attestation,
because it converts an absent control into an apparently-present one, and the signature makes it look
audited. ADR-0042 predicted this precisely and built the right gate; it was simply never pointed at
the app that ships. The `ci.yml:1191-1193` comment asserting no vinext image is published is now
false in the same repo that publishes one. Fixing the recognizer to key on `vinext-compile` rather
than a directory name also makes the next compile job safe by construction.

**3. An ISR/data cache that works in a scaffolded app — or an honest, red, documented refusal.**
(D3, then D4.)
`kn-next create` currently produces an app with no cache handler at all. Combined with a vinext build
that appears not to honour `export const revalidate`, "ISR works on knext" is a claim the tree does
not support, on the default path, silently. The north star is **verified-adapter status**, and
`architecture.md` says gate every feature on the official compatibility suite — a capability that
fails quietly on the only build target is exactly the thing that status is meant to exclude. Note
this is ranked third only because part of it is upstream-shaped: the scaffold half (D3) is entirely
knext's and should ship regardless of what happens to D4.

**Deliberately not in the top three, with reasons.** D11 (body cap) is a real open security control
and ADR-0044's exception can no longer expire now that #742 is closed — but it has a documented
recipe and a stated risk acceptance, which is a different category from a control that *appears*
present. D12 (coverage) is the most embarrassing item here and the least dangerous to a user. D13
(observability) is operationally severe and I nearly ranked it second — it loses only because a blind
operator is recoverable once noticed, whereas a dropped request and an unscanned CVE are not.
