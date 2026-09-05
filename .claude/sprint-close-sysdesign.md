# Sprint close — System Designer half: stability

Subject: the aggregate of PRs #890 #896 #897 #898 #899 #900 #901 #903 #905 #906 #907 #908 on the
chain ending at `origin/agent/d1-metrics-contract`, HEAD **`26f184b3`**. Counterpart planning
artifact: `.claude/plan-stability-sysdesign.md`. Everything below is verified at that ref (detached
worktree) or against the live check-runs for that SHA — not against team reports.

---

## 0. The finding that reframes the sprint

**The product's only shippable artifact has not compiled once during this sprint.**

At the tip, `bun build --compile` fails:

```
1 | import "../chunk-DGUM43GV.js";
error: Could not resolve: "../chunk-DGUM43GV.js"
    at apps/file-manager/.output/server/node_modules/sharp/dist/sharp.mjs:1:8
Bun v1.4.0 (Linux x64)
```

That one error reds **four** of the seven failing checks at `26f184b3`: `knext adapter smoke (bun)`,
`knext adapter smoke (node)`, `Prod image next/image optimization`, and `SBOM + Trivy (+ cosign sign
on main)` (the last two die inside `docker buildx`, same message, same line).

It is **not a late regression**. I fetched the job logs for the sprint's *first* commit,
`2f1a703e` (ADR-0048): the `Prod image` job failed there with the identical
`chunk-DGUM43GV.js` error. Meanwhile `origin/main` (`ddadaff5`) is green apart from two nightly
lanes. So: **the branch has been red on the publish path since the day the sprint opened, and six
teams shipped onto it without anyone making it green.**

This is my planning artifact's organising observation — *the proof and the artifact have come
apart* — in its strongest form yet, and it now points the other way. Last sprint the artifact moved
and the proofs stayed behind. This sprint the **proofs were repaired beautifully** (a real TERM to a
real container, a closure SBOM bound to the pushed digest, a metric-name gate, three measured cache
bugs) **while the artifact itself stopped building**, and no gate reported that as the headline,
because each team's own lane was about its own proof.

---

## 1. The three things I said I would refuse to ship v1.0 without

### (a) SIGTERM drain proof on the shipped binary — **MET, with one honest gap**

`examples/bun-exec/test/alpine-image.docker-e2e.test.ts:606-643` is real and it is what I asked for:
a request genuinely in flight (`/api/slow?ms=4000`, `:611`), `docker kill --signal=TERM` (`:616`),
then three independent assertions — the in-flight request returns **200 with its full body**
(`:621-623`), the container exits **0 on its own** via `docker wait` (`:628-633`), and both drain
markers appear **in order** (`:639-641`). It runs per-PR in `bun-exec-alpine-image`
(`.github/workflows/ci.yml:1273`, `needs: vinext-precompile-closure`, no `if:`, no
`continue-on-error`), and that job is **green at the tip**.

I checked the thing that would have made this hollow: whether `examples/bun-exec`'s copy of the
runtime is the shipped one. It is. `diff turbo/generators/templates/zone/runtime-contract.mjs.hbs
examples/bun-exec/runtime-contract.mjs` is a 13-line header comment plus two JSDoc brace
reflows — **zero** functional divergence; the entry differs by the header alone. The drain code
under test is the drain code that ships.

Gaps, both accept-class:

- **The hardcap path is still not proved on the binary.** My exit criteria named two mutations;
  only one was performed. `s.stop()` → `s.stop(true)` was mutation-proved (recorded in `26f59719`'s
  message: "reddens exactly this test... while the other 12 stay green; restored byte-identical").
  Deleting the hardcap `setTimeout` has no binary-level test to redden — exit-1/force-stop is still
  covered only by `sigterm-hardcap-e2e.test.ts`, which spawns harnesses under plain `bun`.
- **The mutation proof is a commit message, not a script.** `scripts/` gained no
  `mutation-prove-sigterm-*.mjs`; `run-mutation-provers.mjs` does not cover it. By this repo's own
  standard (`workflow.md`: "a script that asserts its anchor occurs exactly once"), the proof is
  unrepeatable.
- **Nothing pins the three checked-in app copies** (`apps/docs/`, `apps/file-manager/`,
  `examples/bun-exec/`) to the templates. `create-scaffold-parity.test.ts:47-56` pins the two
  *template trees* byte-identically (correctly, and `runtime-contract.mjs.hbs` /
  `knext-bun-entry.mjs.hbs` are both in `VERBATIM`) — but the file the SIGTERM e2e actually compiles
  is an unpinned copy. It is identical today by luck and diligence, not by construction.

**And a regression the sprint created here.** `SIGTERM drain (legacy standalone supervisor)` is
**red at the tip**: `apps/file-manager/sigterm-drain-e2e.test.ts` fails with `pnpm deploy did not
produce a self-contained @getknext/core (node-server.js + prom-client + pino)`. `pnpm` was removed
this sprint (`fe28ad9c`, "build: remove pnpm — one package manager, one lockfile"). #887 correctly
moved the *binary's* drain proof to where the binary is; the toolchain change then killed the gate
on the runtime that stayed. `node-server.ts` still ships — exported at
`packages/kn-next/package.json:64-67`, built at `tsup.config.ts:70,125`, and it is the back-compat
runtime for stored `build=turbopack` CRs. So at this tip the repo has **one** green SIGTERM gate and
**one** red one, and the red one guards a runtime users can still be running.

### (b) A supply-chain gate that sees the production closure — **MET, and well**

This is the strongest piece of engineering in the sprint. In `supply-chain.yml`, inside the *real*
publish job `image-supply-chain`:

- `:105-106` — `node scripts/precompile-closure-audit.mjs --app apps/file-manager` runs at step 105;
  the image build is at `:138`. **Gate before compile**, by step order in one job, which is the
  strongest form available.
- `:321-322` — **both** SBOMs are attested onto the pushed digest: `--type spdxjson` (OS packages)
  and `--type cyclonedx --predicate sbom/app-closure.cdx.json` (the ~560-component JS closure). The
  vacuous-attestation problem I described is closed.
- The ordering invariant is preserved: build to a local OCI layout → SBOM → Trivy → `crane push` →
  verify provenance survived (`:273-286`) → sign → attest.

The recognizer was fixed the way I asked. `ci.yml:1160-1167` documents that
`tests/precompile-closure-gate-ci.test.ts` now **scans every `.github/workflows/*.yml`** for any job
that compiles the binary or builds its image, including via the `bun run build` → `./build.sh`
alias, and requires a closure audit in the transitive `needs:` closure. The stale
`"NO VINEXT IMAGE IS PUBLISHED FROM CI TODAY"` comment is not merely deleted but **corrected in
place with a date and the reason it was once true** (`ci.yml:1148-1150`).

It is also honest about its blind spots without being asked: `ci.yml:1165-1167` names what the scan
cannot see — a lane compiling through a reusable workflow, a composite action, or a shell wrapper —
and states that adding one means extending `tests/helpers/vinext-artifact-scan.ts` in the same PR.

**The one thing that undoes it: this lane has never completed.** `SBOM + Trivy (+ cosign sign on
main)` is red at the tip on §0's compile error. The gate is correct; it has not yet gated a
successful build.

### (c) ISR in a scaffolded app — **MET on the scaffold half; the end-to-end proof is a shape short**

**My §1.3(a) was wrong, and the sprint proved it wrong by measurement.** I concluded vinext drops
`export const revalidate`. `bbe9f856` measured it against the built app with
`NEXT_PRIVATE_DEBUG_CACHE=1` and found vinext honours the route-segment config exactly as Next does.
The defect was **three knext-side cache-handler bugs**, each pinned by a test:

1. `bunRedisClient` passed `idleTimeout: COMMAND_TIMEOUT_MS` to Bun's native client believing it was
   a per-command budget. It is an **idle-connection reaper** — measured on bun 1.3.5 / redis:7 at
   2000 ms: 3 s idle survives, 5 s and 11 s both fail `ERR_REDIS_CONNECTION_CLOSED`, and
   `client.connected` still reads `true` across the reap. On a scale-to-zero pod every gap exceeds
   any command budget, so the cache flapped between Redis and the in-memory fallback — which is
   #886's evidence table exactly (MISS on the redis path, SET landing in memory).
2. No stale-while-revalidate: the entry was written `EX <revalidate>`, so `revalidate = 1` **deleted
   itself after one second** and `get` returned no `cacheState`.
3. On the native client a `MULTI` lives on the **connection**, so an ordinary `GET` between another
   caller's MULTI and EXEC was queued into that transaction and answered `+QUEUED` — read as a miss.

This is the "discovered fact that invalidates the plan" trigger firing correctly, and the team
followed the evidence rather than the plan. It also corrects check (k), which asserted two
back-to-back requests render the *same* value — not a guarantee under SWR — to assert
`x-nextjs-cache != MISS` on both, which is the direct evidence.

Scaffold half (D3): done. `packages/kn-next/templates/app/next.config.ts.hbs:40-42` sets
`cacheHandler` + `cacheMaxMemorySize: 0`; `cache-handler.js.hbs` ships in both template trees and is
classified `VERBATIM` in the parity guard; `create-scaffold.test.ts:233` and `:240-248` assert both,
red-first per `e1826c4a`. `e1826c4a` also caught a duplicate `export default nextConfig;` in the
zone template — a syntax error in **every** generated zone.

Remaining gaps:

- **Nothing builds a scaffolded app and exercises ISR.** The SET/HIT proof (check k) runs against
  `apps/file-manager`, whose config uses `path.resolve(import.meta.dirname, 'cache-handler.js')`
  (`apps/file-manager/next.config.ts:34`) while both templates use
  `new URL("./cache-handler.js", import.meta.url).pathname`. Equivalent on POSIX; `.pathname`
  yields `/C:/...` on a Windows dev host. The generated form is asserted by grep, never executed.
- **And check (k) did not run at the tip** — the lane dies at §0's compile step. The ISR fix is
  verified in the commit author's local run and by nothing in CI at this SHA.

---

## 2. §4.2 retired-shape guard table — state at the tip

| Row (plan §4.2) | State | Evidence at `26f184b3` |
|---|---|---|
| `standalone-seam-alive.test.ts` (red CI job) | **RESOLVED, minus a rule citation** | File + `scripts/seam-alive-apps.mjs` deleted (`220dc3b6`); `ci.yml:479-487` marks the job RETIRED with rationale; the invariant is back-filled *negatively* by `template-guarded-instrumentation.test.ts:247` ("does NOT ship standalone-seam-alive.test.ts") and `:306`. **But** `.claude/rules/architecture.md:50` still names the deleted file as mandatory-by-path; the amendment sits unlanded at `docs/adr/drafts/rules-amendment-architecture-s4.md`. Correct handling (`.claude/rules/` is maintainer-owned) — **maintainer action**. Also stale: `ci.yml:853` and `:926-927` still claim `seam-alive` covers file-manager. **No replacement guard** asserts single-instantiation on the binary. |
| `sigterm-drain-shipped` (misnamed, green) | **RESOLVED in name, RED in fact** | Renamed to `SIGTERM drain (legacy standalone supervisor)`, `ci.yml:389`, with an explicit `#887 HONESTY NOTE` at `:390-404` that says outright its subject is node-server, **not** the artifact new builds produce. Exactly the right fix. It is now red for the pnpm reason in §1(a). |
| `node-compile-cache.test.ts` | **STILL PRESENT** | `:19,23-26` still points at `.next/standalone/apps/file-manager/server.js`; self-skips forever. |
| `bun-portability.test.ts` | **STILL PRESENT** | `:24`, same dead path, same permanent self-skip. |
| `compat-smoke.mjs:54` stale default | **STILL PRESENT** | `:53-54` default is still the standalone `server.js`; masked because `ci.yml:384-386` always overrides. Its error message (`:264-265`) also still says `pnpm --filter …` — a package manager the repo deleted this sprint. |
| `warm-compile-cache.sh` dangling refs | **PARTIAL** | Script confirmed absent; `apps/file-manager/dockerfile.test.ts:132` positively guards its absence. Still dangling and **present-tense**: `apps/docs/DEPLOY.md:29-36` ("Also vendor the shared compile-cache warm-up") and `.claude/rules/security.md:34-35` (describes it as currently "stable"). ADR-0035/0042 references are historical — fine. |
| `validate.ts:56` stale comment | **STILL PRESENT** | Still says "with only `turbopack` available today", contradicted by `:71` in the same file, which defaults `build` to `"vinext"`. |
| db-demo coupling (D17) | **HELD, correctly** | `apps/db-demo/package.json:8` still `next build --webpack`; `ci.yml:184,446-447,468`. My "fix D1 before migrating db-demo" edge was respected — D1 landed, db-demo untouched. |
| `node-server.ts` "not dead, do not delete" | **RESPECTED** | Present, exported (`package.json:64-67`), built (`tsup.config.ts:70,125`). |
| `tests/seam-alive-app-coverage.test.ts`, `tests/warm-compile-cache-harness.test.ts` | **RESOLVED** | Both deleted (`220dc3b6`, `773ce7bd`); zero surviving references in `ci.yml`, `turbo.json`, `vitest.config.ts`, `scripts/`. |

Score: 4 fully resolved, 2 resolved-with-a-doc-tail, 4 untouched. The four untouched are all
green-but-vacuous or stale-comment class — genuinely low severity, but they are the same class of
debt that produced this sprint's headline work, so they should not survive another sprint.

---

## 3. New failure modes the sprint introduced

### 3.1 compat-smoke check (h) cannot pass in single-exec mode — **SEV-2, latent behind §0**

`singleExec = SERVER_CMD === SERVER_PATH` (`apps/file-manager/scripts/compat-smoke.mjs:290`) is used
in exactly **two** places — both on line 290-291, to choose the spawn args. It gates nothing else.

Check (h), the bun keep-alive guard contract, is `check('h. …', fn)` with default
`lanes = ['node','bun']` (`:235`), and `LANE === 'bun'` whenever `RUNTIME=bun` (`:232`). CI sets
`RUNTIME: bun` **and** `SERVER_CMD = SERVER_PATH = …/knext-smoke-exec` (`ci.yml:382-384`). So at
`compat-smoke.mjs:471` the check runs:

```js
const bunVersion = execFileSync(SERVER_CMD, ['--version']).toString().trim();
```

where `SERVER_CMD` is **the compiled application binary**, not `bun`.

**Measured, not assumed.** I compiled a trivial binary locally (`bun build --compile`, bun 1.3.5)
and ran it with `--version`:

```
APP_RAN argv= /$bunfs/root/app,--version
```

A `--compile` binary does **not** intercept `--version`; argv goes to the app. So that line boots a
**second instance of the server**. Its env is the smoke runner's (no `PORT`), so the entry defaults
apply: `PORT` 3000 (`knext-bun-entry.mjs:117`) and `METRICS_PORT` **9091** (`:122`) — and 9091 is
already bound by the instance under test, which is spawned without a `METRICS_PORT` override
(`compat-smoke.mjs:300-308`). Either it dies on the port collision and `execFileSync` throws with an
opaque message, or the port is free and `execFileSync` — which has no timeout — **blocks forever and
hangs the job**.

Residual uncertainty, stated: my measurement is on bun 1.3.5; CI compiles with 1.4.0. I know of no
documented change, but the honest statement is "measured on 1.3.5, unmeasured on 1.4.0". This is
invisible today only because the lane dies at the compile step before reaching check (h) — it
becomes the *next* failure the moment §0 is fixed. The fix is one line: pass `lanes` or add an early
`if (singleExec) return 'single-exec: embedded bun ≥1.4, guard not applicable'`.

### 3.2 The nitro staging temp dir leaks on every deploy — **SEV-2, a genuine regression**

`stageNitroPublicAssets` (`packages/kn-next/src/utils/asset-upload.ts:601-629`) does
`mkdtempSync(join(tmpdir(), "knext-upload-"))` at `:619` and `cpSync(sourceDir, stagingDir,
{recursive:true})` at `:620` — the **entire** `.output/public` tree. **Nothing ever removes it.**
There is no `rmSync`, no `finally`, no exit handler for that path anywhere in the file; the only
`rmSync` (`:527`) belongs to `stageStandaloneAssets`, which cleared its own reused directory. The
sole caller, `uploadAssets` (`:637`), returns `Promise<void>` — it does not even hand the path back,
so no caller *could* clean up. The deploy failure path (`deploy.ts:537-579`) reclaims the remote
prefix and never touches the local dir. `asset-upload-stage.test.ts:47-48` leaks one per test run.

This came in with `95bcb91e`, which replaced an in-repo `.knext-upload` dir (cleared every run) with
`mkdtempSync` to fix the buildx-context race. The race fix is right; the cleanup was dropped with
the directory reuse. Cost: one full copy of the app's static output per deploy, forever, on every
build host and CI runner.

**And the new guard cannot see it.** `tests/temp-dirs-outside-the-repo.test.ts` is a static source
scan: it regexes every `mkdtemp(Sync)?(` call and checks only that the first ~140 chars of the first
argument mention a `tmpdir`-ish token (`:59,72-86,93-108`). It asserts **location**, never lifetime.
`mkdtempSync(join(tmpdir(), "knext-upload-"))` passes it cleanly while leaking on every call. That
is a guard asserting one half of its own subject — issue #639's exact class, produced this sprint.

Correct in the same area: `--skip-upload` does **not** pay the copy. `deploy.ts:489` gates the whole
`uploadAssets` block, so no temp dir is created when uploads are skipped. The destination key space
is unchanged (`appKeyPrefix` `:47-49`, `getAssetPrefix` `:103-106`, shared by both stage functions),
so there is no prefix regression and no 404 risk from a key-space move.

### 3.3 Native integrity: the warn-and-load path is bounded, and honestly so — **ACCEPT**

`sharp-addon-dlopen.mjs:140-149`: an **absent** `.integrity.json` is a `console.warn` and load;
unreadable manifest, unlisted payload, and hash mismatch are all **fatal** (`:155,168,191`), and
every listed payload is checked, not just the addon being opened (`:134-138` — libvips comes in
transitively off a relative rpath and never passes through the shim, so verifying only the addon
would leave the more easily swapped binary unpinned). Two-tier strength is stated plainly in
`36ea186f`: lockfile provenance pins *which package*, sha256 pins *which bytes*, and the commit says
so rather than overclaiming.

The downgrade surface is real (delete the manifest → warn → load) but **bounded by construction**:
`packages/kn-next/templates/app/Dockerfile.hbs:65-67` fails the image build when
`native/.integrity.json` is missing, and the published app's own
`apps/file-manager/Dockerfile:125-126` writes it and `test -f`s it. So every image built by a current
template carries one, and the warn path covers only pre-C2 images plus an attacker who already has
filesystem write — who could swap the addon regardless. I accept it.

What I would add next sprint, because this repo has been bitten by exactly this shape before
(ADR-0044's expiry that cannot fire): the absence exception has **no expiry and no override**. Give
it a dated expiry and a `KNEXT_REQUIRE_NATIVE_INTEGRITY=1` fail-closed switch, so "absence is
tolerated" stays a decision rather than becoming a permanent property.

### 3.4 Metric rename: the contract is real; the consumers are half-migrated — **ACCEPT, mostly**

Emitted now (`turbo/generators/templates/zone/runtime-contract.mjs.hbs:357-408`):
`knext_bunexec_{process_resident_memory_bytes, process_uptime_seconds, startup_duration_seconds,
http_requests_total{status_class}, http_inflight_requests, http_request_duration_seconds}`. My D14
ask is met: `status_class` on the counter (`:385`) and a duration histogram (`:393-405`) — so an
error rate and a latency SLO are computable again. **No route label**, deliberately and documented
(`:258-261`), with `observability-metric-contract.test.ts:253-266` asserting the counter never grows
`route|path|url|method`. That is the right call and I endorse it.

My D13 ask — **staleness first** — was honoured, and improved on. `prometheusrule.yaml:138-183`,
group `knext.app.staleness`: `KnextAppMetricsTargetDown` (`up{job="knext-nextapp"} == 0`, `for: 10m`)
and `KnextAppMetricsContractBroken` (`(up == 1) unless on (namespace,pod)
knext_bunexec_process_uptime_seconds`, `for: 15m`). They deliberately anchor on `up` rather than
`absent()`, because a bare `absent()` would fire nightly on every legitimately scaled-to-zero app
(`:131-137`). That is a better answer than the one I asked for.

The gate exists and is wired: `observability-metric-contract.test.ts` scans **all** of
`config/grafana/dashboards/*.json` (`:47,363`) and `prometheusrule.yaml` (`:48-53`), fails closed on
any unclassified group or dashboard (`:318-326,367-376`), and pins all five checked-in runtime-contract
copies to the same metric set (`:71-77,295-304`). It runs in `Lint & Test` via `scripts/bun-test.mjs`.
`bytecode.json` and `rum.json` were **deleted**, not blanked, with the reason recorded at
`config/grafana/kustomization.yaml:40-48` — deleting a dashboard whose subject is gone is the
outcome I named as legitimate.

Not met: **end-to-end mutation proof**. The file's docblock argues it is self-proving by
construction; the executed fail-first tests target the *extractor* (`:395-446`, a fabricated
`knext_totally_made_up_total`), not a real rename in `runtime-contract.mjs.hbs`. That is the
difference between "this scanner works" and "renaming an emitted metric reds CI", and only the
second is the guarantee.

**Surviving old-name consumers** (each verified untouched by `1da46f78`/`26f184b3`):

- `apps/docs/content/docs/observability.mdx` — **published, user-facing**. `:33-42` presents
  `kn_next_*` as *the* contract with zero mention of `knext_bunexec_*`; `:55,70-76` advertise **five**
  dashboards including "RUM — Web Vitals" and "Bytecode cache", both **deleted this sprint**;
  `:87` claims every other panel reads a `knext_*` series on 9091. `workflow.md` step 5 makes the
  docs site part of delivery, not a follow-up.
- `docs/security/threat-model.md:238-253` — **security-relevant**. Describes what is exposed on the
  NetworkPolicy-gated `:9091` as prom-client output with `method` labels, coldstart/db_wake/
  deep_health series and `collectDefaultMetrics` defaults. None of that is on `:9091` any more; it
  materially misdescribes the current disclosure surface.
- `docs/observability/metrics.md:16-40` — **self-contradictory in one file**: this section still says
  `:9091` is served by the `node-server.ts` supervisor via a cross-process bridge, while `:48-102`
  (rewritten by #792) correctly says the compiled executable serves it.
- `docs/runbooks/incident.md:78-89,105-114` and `docs/runbooks/troubleshooting.md:251-267` — on-call
  instructions quoting `kn_next_startup_duration_seconds_bucket{cache_status="cold"}` (the real alert
  is a **gauge**, `prometheusrule.yaml:199-200`) and telling the responder to look for
  `KnextCacheUnreachable`, which `prometheusrule.yaml:253-261` documents as **RETIRED**.

Correctly unaffected and correctly classified: the whole `node-legacy` emitter set
(`adapters/metrics.ts`, `apps/file-manager/src/app/api/_metrics/registry.ts`, the `knext.app.node-legacy`
rule group), `internal/controller/metrics.go` (`knext_nextapp_*`), and `packages/scale-zero-pg/`,
which is entirely independent — grepped clean.

### 3.5 The primary test job is red on the sprint's own code — **BLOCK**

`Lint & Test` fails on typecheck: `packages/kn-next/src/__tests__/cache-handler-bun-native-idle.test.ts`
— `(93,35)` and `(147,26)` `TS2554: Expected 0 arguments, but got 1`, `(160,9)` `TS2322: Type
'() => void' is not assignable to type 'null'` — plus a biome format diff. That file arrived in
`f8854bc7`, the sprint's own "close the two coverage gaps a mutation run exposed" commit. The
Codecov "No coverage reports found" line in the same job is non-fatal (`CC_FAIL_ON_ERROR: false`)
but is a second signal that the #884 lcov-merge work is not producing what the gate expects.

### 3.6 The escalation-trigger gate fired and was not acknowledged — **BLOCK (procedural)**

`Escalation triggers acknowledged` is red at the tip:

```
Escalation trigger(s) detected (1):
This PR touches a trigger-class surface and is NOT acknowledged.
      packages/kn-next/src/cli/native-integrity.ts
      packages/kn-next/src/cli/vinext-build.ts
```

`workflow.md` makes `packages/kn-next/src/cli/` a **mechanically detected** trigger precisely so it
is not self-reported by the team that would have to escalate against its own interest. C2 changed
the CLI surface and did not acknowledge it. On the merits I clear the change (§3.3), and this
sprint-close review *is* the design gate — but the acknowledgement still has to be recorded, or the
one mechanism in this model that does not depend on goodwill becomes a check people learn to merge
past. That is the exact sentence `workflow.md` says marks the moment the per-sprint model stops
being acceptable.

---

## 4. The skew-before-GC hard edge — **RESPECTED**

I required D8 (skew protection) to land **before** D6 (GC learns vinext), because D6's absence is
what currently masks D8: nothing is reaped, so an old client's content-hashed chunk URLs still
resolve.

At the tip, neither landed, so the edge holds by construction:

- **D6 open.** `stageNitroPublicAssets` still writes no `BUILD_MARKER_FILENAME`
  (`asset-upload.ts:590-597`, and the marker write exists only in `stageStandaloneAssets` at
  `:552-557`). `pruneOldBuilds:1080-1093` buckets every unmarked prefix into `keptUnmarked` and
  `:1093` returns before `classifyBuilds` when nothing is marked — so vinext ids never reach the
  live-traffic protection at all. `:622-626` warns on every deploy that this is so. #892 open.
- **D7 open.** `reclaimBuildPrefix` (`deploy.ts:570` → `asset-upload.ts:975-988` →
  `staticBuildDeleteUri:921-939`) still deletes `<app>/_next/static/<deployTag>/`, a prefix vinext
  never writes, and still logs that it reclaimed something.
- **D8 inert.** `deploy.ts:442-460`'s BUILD_ID lock-step still ENOENT-warns
  (`".next/BUILD_ID not found — skipping build-id lock-step check"`); neither
  `packages/kn-next/templates/app/next.config.ts.hbs` nor the zone template sets `deploymentId`;
  `cr-builder.ts` has no `deploymentId`/`DEPLOYMENT_ID` occurrence. `deploy.ts:399` sets
  `process.env.NEXT_DEPLOYMENT_ID` in the **CLI's own process** only — it never reaches the pod.
  Note `deploy.ts:390-397`'s comment claims the next.config reads it "BOTH as `deploymentId` … AND …
  `generateBuildId`" — the template implements **neither**; that comment is aspirational and should
  be corrected or made true.

**Nothing this sprint unmasked the dead skew path.** I checked the two candidates: the staging
change (`95bcb91e`) alters only *where the copy is made locally*, not what is uploaded, and no
provider call gained a `--delete`. Uploads remain additive-only.

One thing to carry forward: the masking is now *louder* — `asset-upload.ts:622-626` warns on every
single deploy that assets will be over-kept forever. Warning on every run is how a warning stops
being read.

---

## 5. Block vs accept

### BLOCK the stack merge

1. **The artifact does not compile.** `Could not resolve: "../chunk-DGUM43GV.js"` at
   `.output/server/node_modules/sharp/dist/sharp.mjs:1:8` under `bun build --compile` (bun 1.4.0),
   reddening compat-smoke (bun + node), `Prod image next/image optimization`, and
   `SBOM + Trivy (+ cosign sign on main)`. Present since `2f1a703e`, the sprint's first commit;
   `origin/main` is green. Nothing else on this list matters until this does.
2. **`Lint & Test` red** — 3 TS errors + a format diff in
   `packages/kn-next/src/__tests__/cache-handler-bun-native-idle.test.ts:93,147,160`, from this
   sprint's own `f8854bc7`.
3. **`SIGTERM drain (legacy standalone supervisor)` red** — `apps/file-manager/sigterm-drain-e2e.test.ts`
   shells `pnpm deploy`, and `fe28ad9c` removed pnpm. `node-server.ts` still ships; its drain gate
   must be green or the runtime must stop shipping.
4. **`Escalation triggers acknowledged` red** — the CLI-surface trigger fired on
   `cli/native-integrity.ts` + `cli/vinext-build.ts` and is unacknowledged (§3.6). Cleared on the
   merits; the acknowledgement must still be recorded.
5. **compat-smoke check (h) in single-exec mode** (§3.1) — one-line fix, and it is the next failure
   after #1 is cleared. Fix it in the same pass or the lane simply reds again, or hangs.

### ACCEPT as next-sprint debt

- Temp-dir leak per deploy (`asset-upload.ts:619`), and `tests/temp-dirs-outside-the-repo.test.ts`
  asserting location but not lifetime (§3.2).
- D6 / D7 / D8 unchanged — deliberate, ordering edge respected (§4).
- Docs drift from the metric rename: `apps/docs/content/docs/observability.mdx` (published),
  `docs/security/threat-model.md:238-253`, `docs/observability/metrics.md:16-40`,
  `docs/runbooks/{incident,troubleshooting}.md` (§3.4).
- Hardcap drain unproved on the binary; SIGTERM mutation proof not scripted; no byte-parity guard on
  the three app copies of the runtime contract (§1a).
- No scaffold→build→ISR SET integration; `new URL(...).pathname` vs `path.resolve` divergence (§1c).
- Native-integrity absence exception has no expiry and no fail-closed override (§3.3).
- Metric gate not mutation-proved end-to-end (§3.4).
- `node-compile-cache.test.ts`, `bun-portability.test.ts`, `compat-smoke.mjs:53-54,264-265`
  (including its stale `pnpm` message), `validate.ts:56` (§2).
- `.claude/rules/architecture.md:50` citation + `ci.yml:853,926-927` stale seam comments; amendment
  drafted at `docs/adr/drafts/rules-amendment-architecture-s4.md` — **maintainer action**.
- `apps/docs/DEPLOY.md:29-36` and `.claude/rules/security.md:34-35` still describe
  `scripts/warm-compile-cache.sh` as live (§2).

---

## 6. Next sprint — my top three

1. **Make the artifact build, and make "it built" a first-class sprint exit criterion.** Fix the
   sharp/nitro chunk resolution, then adopt the rule this sprint's evidence demands: a sprint does
   not close on a branch whose publishable artifact has never compiled. The gate already exists —
   compat-smoke now compiles the binary per PR — it has simply never been green. Every proof this
   sprint built (the closure attestation, the metric contract, the ISR fix) is currently a claim
   about a path CI cannot reach.
2. **One green, mutation-proved drain gate per shipping runtime.** Un-pnpm
   `sigterm-drain-e2e.test.ts` (or retire `node-server` deliberately, which is a decision, not a
   cleanup), add the hardcap exit-1 case to the alpine binary e2e, and commit both mutations as
   scripts under `scripts/mutation-prove-*`. Then pin the three app copies of
   `runtime-contract.mjs` / `knext-bun-entry.mjs` to the templates, so the artifact under test stays
   the artifact that ships by construction rather than by diligence.
3. **The data plane, in the order the dependency edge requires: D8 → D6 → D7, plus the temp-dir
   leak.** Set `deploymentId` in both templates and inject it into the CR container env *before*
   teaching GC the vinext namespace — fixing GC first removes the accidental protection that stale
   hashed chunks currently enjoy. The temp-dir leak rides along: it is the cheapest fix on the board
   and it is a regression this sprint created.

**One process change I would argue for.** Five of the seven red checks at the tip are not any single
team's lane — they are the seams between teams (a package manager removed under another team's test,
a CLI trigger nobody acknowledged, a compile step that has been broken since day one while six teams
built proofs on top of it). Per-PR review saw each change; nothing owned the branch. Whatever the
sprint model is, **someone has to own "is the stack green" continuously**, not at close.
