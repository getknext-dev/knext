# ADR-0059: Running user code at image-build time to bake the compile cache

- **Status:** **Proposed (2026-09-24).** Trigger-class: it touches a security invariant (what
  runs, with which secrets and which network, inside `docker build`) and it proposes a
  `kn-next.config.ts` field. It needs founder review before merge.
- **Extends** ADR-0035 (the V8 compile cache is baked into the image). ADR-0035 named "the build
  now boots the application server" as new build-time surface area but did not work out a threat
  model for it. This ADR does. **Relates to:** ADR-0054 Amendment 7 and ADR-0058 (bytecode
  caching is mandatory in every credentialed cell), ADR-0055 (the image declares its own start),
  ADR-0056 Amendment 1 D4 (liveness grading).
- **Implements:** #1303 (c). **Records:** #1264 / #1271 (standalone-node bake), #1263 / #1273
  (vinext × node bake), #1275 (the sprint-close question this answers), #1297 (validate
  `healthCheckPath`), #1299 (move the harness-only knob out of the shipped template).

## Context

Bytecode caching is mandatory in every credentialed cell (ADR-0054 Amendment 7, ADR-0058). Bun
cells get it from the compiled `--bytecode` executable, which is made by a compiler and runs no
app code at build time. Node cells get it from a V8 compile cache, and V8 only writes a cache for
code it actually compiled, in a process that ran it. So the node images **boot the app at build
time**:

- **node × turbopack / webpack (standalone).** `Dockerfile.standalone.hbs:229` runs
  `node /app/knext-compile-cache-bake.mjs`. The driver imports Next's generated `server.js`
  in-process (`knext-compile-cache-bake.mjs.hbs:101`), waits up to 30 s for it to answer
  (`:103`), fetches `KNEXT_WARM_PATH` (default `/api/health`, set from the
  `KNEXT_HEALTH_CHECK_PATH` build-arg, `Dockerfile.standalone.hbs:220,229`), flushes the cache and
  exits. Any path that does not return 2xx exits 1 (`:122-128`). The build then fails if the
  cache is under 256 KiB (`Dockerfile.standalone.hbs:212,230-235`).
- **node × vinext.** `Dockerfile.vinext-node.hbs:74-81` runs the app's own Nitro entry with
  `KNEXT_COMPILE_CACHE_BAKE=1` (`knext-node-entry.mjs.hbs:67`), which warms, flushes and exits
  under the same fail-closed contract (64 KiB floor).

Starting Next's server runs the app's `instrumentation.ts` `register()` and the top-level code of
every module the warm request loads. **That is user code, running inside `docker build`.** #1275
raised it at sprint close. These are the facts the threat model rests on, each read from the
tree:

1. **Network: open.** `dockerBuildxArgs` (`packages/kn-next/src/cli/runtime-image.ts:305-342`)
   passes no `--network` flag, and neither Dockerfile uses `RUN --network=none`. The bake can
   reach anything the build host can reach.
2. **Build-args: not secret, and visible.** The only build-args the CLI passes are
   `KNEXT_HEALTH_CHECK_PATH` (`runtime-image.ts:317-322`) and, for the app Dockerfile only,
   `NEXT_DEPLOYMENT_ID` and `ASSET_PREFIX` (`:326-333`). Build-arg values are recorded in image
   history, so a secret must never travel that way.
3. **`.env` files can reach the image and the bake.** `standaloneDockerignore()` excludes `.env`
   and `.env.*` (`runtime-image.ts:381-383`), but `.dockerignore` patterns are anchored at the
   context root. Next's own standalone step copies the loaded `.env` and `.env.production` into
   `.next/standalone/` (Next 16.3, `next/dist/build/index.js`, `writeStandaloneDirectory`), and
   `Dockerfile.standalone.hbs:166` copies that tree into the image. So an app built with a
   populated `.env.production` ships it, and the bake runs with it loaded. This comes from reading
   Next's source. It has **not** yet been measured in a built knext image.
4. **Filesystem: mostly read-only to the bake.** The tree is copied as root
   (`Dockerfile.standalone.hbs:166-176`), and the bake runs as uid 65532 (`:189`), which owns only
   the compile-cache directory (`:186-187`) and `/tmp`. A render that tries to persist state into
   the tree fails with EACCES instead of shipping it. The vinext × node recipe follows the same
   pattern (`Dockerfile.vinext-node.hbs:44,47`). The harness shows that such state does get
   written when the tree is writable: it snapshots and restores the fixture tree around its bake
   so that ISR entries, counters and `after()` logs do not leak into the test
   (`scripts/e2e-deploy.sh:617-638`).
5. **The scaffolded `register()` does nothing at build time.** It returns early off the Node
   runtime (`templates/app/src/instrumentation.ts.hbs:32-35`), and `registerNode()` returns before
   starting OTel or the metrics child unless `OTEL_TRACING_ENABLED=true`
   (`instrumentation-node.ts.hbs:58-66`), which the operator sets at runtime and the build never
   does. The risk is in apps that **change** `register()`, for example to open a database pool,
   run migrations, or call a licence or feature-flag service.
6. **Nothing tells user code it is inside a bake.** The vinext × node bake sets
   `KNEXT_COMPILE_CACHE_BAKE=1`, but the standalone bake sets only `PORT`, `HOSTNAME` and
   `KNEXT_WARM_PATH` (`Dockerfile.standalone.hbs:229`). There is **no opt-out** in either recipe.
7. **A harness-only knob lives in the shipped template.** `KNEXT_WARM_ACCEPT_ANY_STATUS=1`
   (`knext-compile-cache-bake.mjs.hbs:66-70`) relaxes the 2xx rule. Only the compat harness sets
   it (`scripts/e2e-deploy.sh:629`), but every image carries the code (#1299).

## Decision

1. **Keep booting the real app to bake the cache.** It is the only way that covers the app's own
   route chunks as well as the framework, and it is what the node cells' liveness grade measures
   (ADR-0056 Amendment 1, D4). The standalone bake is known to cover more than the framework:
   522 entries accepted at boot, 388 of them under `node_modules/next/dist`
   (`Dockerfile.standalone.hbs:203-211`).
2. **Run the bake with no network.** Both bake `RUN` steps become `RUN --network=none …`. The warm
   request goes over loopback, which `none` keeps. Anything `register()` tries to reach
   off-host fails fast. If `register()` blocks on it instead, the warm request waits. The
   driver's 30-second readiness deadline (`knext-compile-cache-bake.mjs.hbs:79-95`) is only
   checked between attempts, and its `fetch` has no timeout of its own, so a hung request would
   stall the build until the HTTP client gives up. The driver therefore gets a per-request
   timeout, so a blocked `register()` fails the build within the deadline and the error names
   the bake. Nothing leaves the build host either way.
3. **Tell user code it is being baked.** Both recipes set `KNEXT_COMPILE_CACHE_BAKE=1` during the
   bake, and the docs publish it as the contract: *if this is set, do not open connections, run
   migrations or write state.* The scaffolded `register()` gains the check, so a generated app is
   safe by construction and an edited one has an obvious place to put it.
4. **Opt-out is a framework-only bake, not "no bake".** A new config field,
   `compileCache: { bake: 'app' | 'framework' }` (default `'app'`), selects a driver that loads
   Next's framework modules and **never** imports `server.js` or any app module. This keeps the
   cell bytecode-live without running user code. The earlier framework-only harness bake from
   #1280 measured 416 accepted and about 9 missed entries at boot. That is well above the grading
   floors (≥ 100 accepted, hit ratio ≥ 0.5), so the opt-out stays inside the supported surface.
   Turning baking off completely would take a node cell outside the supported surface
   (ADR-0054 Amendment 7), so it is not offered. The opt-out covers the standalone shape (the
   four v1.0 cells' node half). The vinext × node bundle mixes framework and app code in one
   Nitro output, so a framework-only bake is not defined for it yet. That cell is descoped from
   v1.0 (ADR-0058), and its opt-out is left to the amendment that brings it back.
5. **Secrets never reach the bake.** knext passes no secret as a build-arg and mounts no BuildKit
   secret into the bake. The bake gets only the env the Dockerfile sets. The `.env` leak in fact
   3 is closed at the source: the standalone staging step deletes `.env*` from
   `.next/standalone/` before `docker build`, and a test asserts that no `.env*` file is left
   under the staged context. Runtime configuration comes from Kubernetes Secrets, as
   `.claude/rules/security.md` already requires.
6. **Keep the product bake strict.** The 2xx rule stays the default, and the harness-only
   accept-any-status knob moves out of the shipped template into the harness (#1299).
   `healthCheckPath` is validated before it reaches the build: a leading slash is required, and
   commas and whitespace are rejected, because a comma would split `KNEXT_WARM_PATH` (#1297).

### Threat model (the bake step only)

| Threat | Before this ADR | After |
|---|---|---|
| `register()` opens connections, runs migrations or calls external services from the build host | possible (network open) | blocked by `--network=none`; a blocking call fails the build at the bake deadline |
| Secrets exposed to build-time user code | `.env` / `.env.production` copied into the standalone tree and loaded (fact 3) | `.env*` stripped before build; no secret build-args or mounts |
| Secrets baked into the image | same `.env` files ship in the image layer | same fix; a guard test asserts none are staged |
| Build-time state shipped in the image (ISR entries, counters, caches) | mostly blocked: the tree is root-owned and the bake runs as 65532 | unchanged, now documented as a guarantee to keep; the marker lets app code skip writes |
| A harness knob relaxing the fail-closed rule in production | present in the shipped template | moved into the harness (#1299) |
| Build-arg injection through `healthCheckPath` | unvalidated (#1297) | validated in config |
| Supply-chain code in dependencies running at build | runs, with network | runs without network. Import-time code in dependencies cannot be stopped short of the framework-only bake, which is the opt-out |

## Options considered

| Option | Covers app code? | User code at build? | Network at build | Verdict |
|---|---|---|---|---|
| A. Keep today's bake as is | yes | yes | open | rejected: open network and the `.env` leak are unmitigated, and there is no opt-out |
| **B. App bake, hardened: `--network=none`, a marker env, `.env*` stripped, validated path, framework-only opt-out** | yes (framework only for apps that opt out) | yes, sandboxed | none | **chosen** |
| C. Always bake framework-only | framework only (~388 of 522 entries in the measured fixture) | no | n/a | rejected as the default: it gives up app-chunk coverage for every app to protect the few whose `register()` misbehaves. Kept as the opt-out |
| D. No build-time bake; warm at runtime into a volume | yes | no | n/a | rejected in ADR-0035: a PVC is unusable on stock Knative, and an `emptyDir` gives no benefit across cold starts |
| E. Drop bytecode caching for node cells | n/a | no | n/a | rejected: forbidden by ADR-0054 Amendment 7 and ADR-0058 |

jev (jev-1.13.0), on a fact sheet with the facts above: picked B at p = 0.99 (confidence 0.98;
C 0.01, A 0.00, D 0.00). It gave 0.94 that the `.env` exposure is a real risk, 0.76 that
`--network=none` is a sound default, 0.70 that a framework-only bake would still pass the
liveness floors, and 0.68 that the network restriction and the marker should land before rc.1.

## Consequences

- **An app whose `register()` needs the network at startup fails its image build** until it
  checks `KNEXT_COMPILE_CACHE_BAKE` or opts into the framework-only bake. That breaks such apps,
  and it is intended: the build error names the bake and both ways out. The user docs must say so
  before this ships.
- **The bake becomes a documented part of the app contract.** "Your server boots once during
  `docker build`, with no network, as uid 65532, with `KNEXT_COMPILE_CACHE_BAKE=1`" is a promise
  users write code against. Changing it later is a breaking change.
- **The `.env` strip changes behaviour for apps that relied on `.env.production` inside the
  image.** Their values must move to Kubernetes Secrets, which the security rules already
  require. The deploy output should name the stripped files so the change is visible.
- **The framework-only opt-out can pass a liveness grade on less coverage.** Its cold start is
  better than no cache and worse than the app bake. The grade remains a floor, not a speed
  guarantee.
- **Import-time code in dependencies still runs at build.** `--network=none` limits what it can
  do, and the framework-only bake avoids it, but the app bake cannot. This residual risk is
  accepted.
- **The config field is a public schema change** (`kn-next.config.ts`), and it goes through the
  usual CR and schema preflight, so an older CLI cannot emit it to an operator that does not
  know it.

## Action items

- [ ] Add `RUN --network=none` to both bake steps (`Dockerfile.standalone.hbs:229`,
      `Dockerfile.vinext-node.hbs:74`), with a docker e2e showing that a `register()` which
      dials out fails the build and the default app still builds. **Before rc.1.**
- [ ] Give the bake driver's warm `fetch` a per-request timeout inside the 30-second deadline,
      so a hung `register()` fails the build instead of stalling it. **Before rc.1.**
- [ ] Set `KNEXT_COMPILE_CACHE_BAKE=1` on the standalone bake, add the check to the scaffolded
      `register()`, and document the contract on the docs site. **Before rc.1.**
- [ ] Strip `.env*` from the staged `.next/standalone/` in `stageStandaloneBuildContext`, and add
      a guard that reds if any `.env*` file is staged. First measure whether a real knext image
      carries them today (fact 3 comes from reading Next's source only).
- [ ] Move `KNEXT_WARM_ACCEPT_ANY_STATUS` out of the shipped template. *(#1299)*
- [ ] Validate `healthCheckPath`. *(#1297)*
- [ ] Add the `compileCache.bake: 'framework'` opt-out and the framework-only driver, and
      measure its liveness counts on the reference app before documenting it.
- [ ] Close #1275 against this ADR.
