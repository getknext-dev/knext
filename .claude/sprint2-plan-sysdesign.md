# Sprint 2 plan — System Designer half (failure modes)

Grounded in the tree at `origin/agent/sprint-close-blockers` (**`d07e977f`**), not in team reports.
Counterparts: `.claude/sprint-close-sysdesign.md` (my close), `.claude/sprint-close-architect.md`,
`docs/adr/0044-ingress-hardening.md` (Decision 4 pre-constraints + Amendment 2 re-anchor).

Two of the six candidates **collapsed on measurement** — the byte cap and the whole D8→D6→D7 chain.
Both collapses are recorded with the evidence, because in each case the sprint plan's premise (a new
subsystem) is false and the real fix is a flag or a config line. That is this repo's own
"discovered fact" precedent (a measured preflight subsystem collapsing to one flag), applied twice.

---

## T1 — The byte cap (ADR-0044 Option C). **It is a flag, not a front socket.**

### The measurement that collapses it

ADR-0044 Decision 4 assumed Option C means "a knext-owned in-process front socket that owns `$PORT`
and loopback-forwards to the child". That was written when `node-server.ts` spawned a separate
`server.js` and there was **no knext-owned request path** (ADR-0044:69-74). ADR-0048 removed that
premise: the compiled binary's entry *is* the request path, and it already serves through srvx.

Measured in the tree, not assumed — `examples/bun-exec/node_modules/srvx@0.11.22`:

- `dist/_chunks/types.d.mts:130-135` — `ServerOptions.maxRequestBodySize`, documented
  "**Bun**: mapped to Bun's native `maxRequestBodySize` (413 before the handler)".
- `dist/adapters/bun.mjs:59` — the option is forwarded into `Bun.serve` when set.
- `dist/_chunks/_body-limit.mjs` — srvx's own fallback (`limitBodyStream`) is **counted bytes**
  (`size += value.byteLength`), never `Content-Length`; it errors the stream and carries
  `statusCode: 413`, `code: ERR_BODY_TOO_LARGE`.

So the entire cap is:

```js
// knext-bun-entry.mjs.hbs, in the existing serve({...}) call at :150
maxRequestBodySize: MAX_REQUEST_BYTES,
```

plus the same key on the `:9091` `Bun.serve` (`:196`), which today accepts a 128 MB body (Bun's
default) on a listener that answers exactly one GET — the co-resident-pod path ADR-0044 §Threat
scope names as unbounded.

### The one experiment that decides the task's shape (do this FIRST, before any code)

**Does Bun's native `maxRequestBodySize` count bytes, or trust `Content-Length`?** ADR-0044
Decision 4 says counted-bytes, never `Content-Length` alone — chunked encoding carries no length.

- Experiment: compile a trivial `serve({ maxRequestBodySize: 1024 })` binary with bun 1.4; send
  (a) `Content-Length: 4096`, (b) `Transfer-Encoding: chunked` with 4 KB in 8 chunks and no
  `Content-Length`, (c) a chunked body that *lies* by declaring a small length then sending more.
- If (b) and (c) are refused → the flag alone satisfies the constraint. **Ship the flag.**
- If either is accepted → the flag is insufficient and the fix is srvx's own counted path:
  `fetch: (req) => nitro.fetch(limitRequestBody(req, MAX))` is **wrong** (it rebuilds the Request
  and drops srvx's expando augmentation — the #460 bug-2 class), so the sound form is to keep the
  flag *and* add a counting `TransformStream` inside the existing srvx middleware
  (`:164-178`), which is the only place that already sees every request and does not reconstruct it.

Record the result in ADR-0044 as Amendment 4 either way. A negative result is a finding, not a fail.

### Design (assuming the flag holds)

- **Value.** ADR-0044's own arithmetic: memory limit 1Gi, `containerConcurrency` default 20
  (`nextapp_controller.go:866`). 20 concurrent worst-case buffered bodies must not approach 1Gi, so
  the cap must be ≲ 8 MiB (20 × 8 MiB = 160 MiB). **Default `8388608` (8 MiB)** — generous enough
  that no ordinary route handler notices, bounded enough that the vertical OOM in ADR-0044's
  "what the payload gap actually costs" is arithmetically impossible.
- **Not 1 MiB.** Next's `serverActions.bodySizeLimit` is 1 MB and covers Server Actions only
  (ADR-0044:53-54). Setting the platform cap to the same number makes two different layers answer
  two different errors at the same threshold, which is how a support ticket becomes unanswerable.
  The platform cap sits **above** the framework cap, deliberately, and the docs say so.
- **Config surface: env only — `KNEXT_MAX_REQUEST_BYTES`.** Deliberately **not** a CRD field.
  A `spec.security.ingress.maxRequestBytes` knob trips two triggers at once (CRD/public-API, and
  ADR-0017/#548 upgrade-order: operator-then-CLI), for a value the operator can already deliver
  today through `spec.env` (`cr-builder.ts:305-310`, `#186` plain env). Ship env now; file the CRD
  field as follow-up with its upgrade-order consequence written down at design time, exactly as
  Decision 4 requires. **This is the reason T1 trips no trigger and can run as an ordinary team.**
- **Pass-through, satisfied by construction.** The cap is request-side only; nothing wraps or
  buffers a Response, so unbuffered RSC/SSE streams are untouched. `Upgrade`/101 requests carry no
  body, so the limit never engages. Both must still be *tested*, because "by construction" is what
  this repo keeps discovering to be false.
- **413 shape.** Bun's native rejection shape is unknown to us and must be captured in the same
  experiment. If it is opaque/empty, add one branch in the srvx middleware translating
  `ERR_BODY_TOO_LARGE` into `413` with `content-type: text/plain` and a one-line body naming
  `KNEXT_MAX_REQUEST_BYTES` — the operator reading a 413 in a log needs to know which cap fired
  (framework vs platform vs proxy).
- **Cold-start budget.** One `Number(process.env…)` parse at module scope. Budget: **zero
  measurable delta** — `knext_bunexec_startup_duration_seconds` (`runtime-contract.mjs.hbs:353`)
  must stay inside the existing noise band of the 61 ms claim. If the fallback path (counting
  TransformStream) is needed, budget becomes per-request, not per-boot, and the histogram
  `knext_bunexec_http_request_duration_seconds` is the instrument that must not shift.

### Exit criteria (testable, red-on-fail, exit-code-based)

In `examples/bun-exec/test/alpine-image.docker-e2e.test.ts` — the only place that already boots the
real shipped binary in a real container:

1. POST `cap-1` bytes → **200**.
2. POST `cap+1` bytes with `Content-Length` → **413**.
3. POST `cap+1` bytes **chunked, no `Content-Length`** → **413**. *(the counted-bytes proof; this
   case is the whole ADR constraint and it must exist even if the flag makes it trivially pass)*
4. An SSE/streaming **response** route still delivers incrementally with the cap set (pass-through).
5. `:9091` refuses an oversize POST and still answers `GET /metrics` 200.
6. `KNEXT_MAX_REQUEST_BYTES` override honoured (set it to 1024 in one case; 2 KB → 413).
7. **Mutation prover** `scripts/mutation-prove-bytecap.mjs` using `scripts/mutate-prove.sh`
   (`:57-64` single-anchor assert, `:84-87` exit-code branch — never output-grep): delete the
   `maxRequestBodySize` key from the entry template, rebuild, assert cases 2/3/5 go **red** and the
   rest stay green.

### Blast radius / edges

Five files carry this entry (see T4): both templates + three checked-in app copies. **T1 must not
start until T4's pinning lands**, or the cap ships in two of five copies and the e2e proves the
wrong one. Otherwise: no operator change, no CRD change, no new dependency, no new listener.

**Clock.** Due at this sprint's close *if* `compat-vinext.yml` publishes its first run (ADR-0044
Amendment 2). Since the flag is ~4 lines, do not wait for the clock to fire — landing it early
retires a live security exception, which is strictly better than renewing it.

---

## T2 — The id flow, end to end. **D8→D6→D7 collapses to one template line plus a re-pointed guard.**

### The measurement that collapses it

`examples/bun-exec/node_modules/vinext/dist/config/next-config.js`:

- `:388-396` `resolveBuildId(generate)` — **`if (!generate) return safeUUID()`**. vinext honours
  `generateBuildId` from the Next config and only falls back to a UUID when it is absent.
- `:424` `resolveDeploymentId` — reads `nextConfig.deploymentId` **or `process.env.NEXT_DEPLOYMENT_ID`
  automatically**.

Neither scaffold template sets either (`packages/kn-next/templates/app/next.config.ts.hbs`,
`turbo/generators/templates/zone/next.config.ts.hbs` — `assetPrefix`, `cacheHandler`,
`cacheMaxMemorySize` only). So today the static namespace is a UUID nobody minted and nobody can
resolve, which is the single root cause of all three symptoms.

The comment at `deploy.ts:390-397` claiming next.config reads it "BOTH as `deploymentId` … AND …
`generateBuildId`" is **half true at the tip**: `deploymentId` is picked up from env by vinext
without any config line; `generateBuildId` is not, and that is the missing half.

### The flow, named per role (this is the deliverable the plan asked for)

| role | who | where | state at tip |
|---|---|---|---|
| **mints** | `kn-next deploy` | `deploy.ts:398` `buildId = options.tag \|\| Date.now()` | works |
| **exports** | `deploy.ts:399` `process.env.NEXT_DEPLOYMENT_ID = buildId` **before** the build | works |
| **consumes → `?dpl=`** | vinext | `next-config.js:424`, from env, automatically | **already works, undocumented** |
| **consumes → static prefix** | vinext | `next-config.js:388` via `generateBuildId` | **MISSING — the fix** |
| **verifies** | `deploy.ts:442-460` reads `.next/BUILD_ID` | vinext writes no such file → ENOENT → warn → **skips every deploy** |
| **marks** | `stageNitroPublicAssets` (`asset-upload.ts:590-626`) | writes no `.knext-build`, warns on every deploy | blocked on the prefix id |
| **labels** | `cr-builder.ts:320` `spec.buildId` → operator stamps `apps.kn-next.dev/build-id` on the revision (`nextapp_controller.go:745`) | works |
| **protects** | `gc.ts` resolves live revisions → that label → `liveBuildIds` | works |
| **prunes** | `pruneOldBuilds` (`asset-upload.ts:1093-1099`) — unmarked ⇒ `keptUnmarked`, returns before `classifyBuilds` | correct, and inert |
| **reclaims** | `reclaimBuildPrefix` → `staticBuildDeleteUri` (`:935-988`) deletes `<tag>/` | deletes a prefix vinext never wrote, and **logs that it reclaimed it** |

**The over-delete hazard I named at close is what the missing line causes, and fixing the line
removes it rather than mitigating it.** `stageNitroPublicAssets:576-586` documents the reasoning
correctly: marking a UUID prefix would let the GC classify the *current* build as reapable while
the protection key (the deploy tag, from the revision label) never matches — an over-delete on the
one path ADR-0011 forbids it. Once the prefix **is** the tag, marker key ≡ protection key ≡ image
tag ≡ CR `spec.buildId`, and the hazard cannot be expressed.

### Smallest sound fix, in dependency order

**T2a (D8) — mint→consume.** Add to **both** `next.config.ts.hbs` templates:
`generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID ?? null` (null → vinext's UUID, so a plain
`vite build` outside `kn-next deploy` is unchanged). Then **re-point the lock-step guard**
(`deploy.ts:442-460`): for `build === 'vinext'`, read the single non-reserved directory under
`.output/public/_next/static/` and assert it equals the deploy tag. Delete the ENOENT-warn-skip on
that leg — a guard that skips on every run is `sprint-close-architect.md` §2.4's
"control that reports success while inert", in the exact place ADR-0011's guarantee lives.

- Exit: (i) a deploy with `--tag=t1` produces `.output/public/_next/static/t1/`;
  (ii) the guard **fails the deploy** when the built id ≠ the tag — proved by mutating the template
  line away and watching the deploy abort (not warn); (iii) `--skip-build` against a `.output` built
  under a *different* tag aborts rather than uploading under the wrong prefix — this is the case
  that silently orphans assets today; (iv) emitted HTML carries `?dpl=<tag>` (pins the
  already-working half so it cannot regress unnoticed).

**T2b (D6, #892) — mark.** `stageNitroPublicAssets` writes `.knext-build` into
`_next/static/<tag>/`, reusing `stageStandaloneAssets`' exact marker logic (`:544-560`) including
the `RESERVED_STATIC_DIRS` deny-list; delete the every-deploy over-keep warning at `:622-626`.
- Exit: the marker rides the normal bulk upload **and** the #75 verify-and-retry set (assert it is
  in `collectFiles`' output); `pruneOldBuilds` now reaches `classifyBuilds` with the vinext id;
  a live build's prefix is in `keptLive`, never in `reaped`; mutation — remove the marker write and
  the "vinext build is reapable" case reverts to `keptUnmarked` (red).
- **Hard edge, unchanged from close: T2b must not land before T2a.** Today's inertness is the only
  thing protecting stale hashed chunks; marking before the ids agree is the over-delete.

**T2c (D7) — reclaim.** With T2a landed, `reclaimBuildPrefix` targets a prefix that exists, and its
warn stops being false. The fix is therefore a **test**, not code: on the upload-succeeded /
push-failed leg, assert the prefix existed before and is gone after; and assert `reclaimBuildPrefix`
is never called with a UUID. Delete the now-stale tag-vs-uuid caveat wherever it is asserted.

**T2d — inject at runtime.** Add `NEXT_DEPLOYMENT_ID` to the CR's `spec.env` in `cr-builder.ts` so
the *pod* carries the id the *bundle* was built with. Baked-at-build makes this belt-and-braces
today; it stops being belt-and-braces the moment anything serves the id at runtime, and a CR that
carries it is trivially assertable now. Exit: `cr-builder` snapshot test asserts the env entry;
`deploy --dry-run` prints it. **Check for a name collision with a user's `config.env` — the operator
emits a Warning event on a colliding `spec.env` name (`nextapp_controller.go` #186); decide
explicitly whether knext's value wins and test that decision.**

Blast radius: 2 templates, `deploy.ts`, `asset-upload.ts`, `cr-builder.ts`. No operator change
(`spec.buildId` and the label already work). `packages/kn-next/src/cli/` ⇒ **CLI-surface trigger
fires mechanically** — acknowledge it up front rather than at close, per §3.6 of my close review.

---

## T3 — Post-compile RuntimeContract smoke (#894), and the defect it already has a subject for

### The finding, verified at the tip: a scaffolded app can never become Ready

- `nextapp_controller.go:755-759` — `readinessProbePath` defaults to **`/api/health`** when
  `spec.healthCheckPath` is unset, and it backs **both** the readiness probe
  (`:1061-1068`, `httpGet` on port 3000, deliberately not `tcpSocket`) **and** the liveness probe
  (`:1076-1085`).
- `packages/kn-next/templates/app/kn-next.config.ts.hbs` sets **no** `healthCheckPath`.
- Neither template ships the route: `git ls-tree` on both template trees shows
  `src/app/{layout,page}.tsx` and nothing under `src/app/api/`.
- `knext-bun-entry.mjs.hbs` registers no health route either — the `:9091` listener 404s everything
  but `GET /metrics` (`:196-208`), and the app listener is pure nitro.

⇒ `GET /api/health` on a scaffolded app returns **404**, a Knative httpGet probe fails on 404, the
revision never goes Ready, and liveness then restart-loops it. Meanwhile the entry's default warm
path is `/api/health` (`:247`), so **every** scaffolded app also logs `WARMED:/api/health
status=404` on every boot — the symptom is already being printed and nothing reads it.

This is #895's class exactly (the scaffolder shipped an app with no cache handler), one layer down,
and it is the strongest argument for #894 that exists: **the smoke's first run would have caught it.**

**T3a (ship the contract).** Add `src/app/api/health/route.ts` to both templates — shallow by
construction (`return Response.json({ ok: true })`, `export const dynamic = 'force-dynamic'`), never
touching a DB, per ADR-0026/#338's "must not deep-check a scale-to-zero DB or readiness flaps on
every cold wake". Exit: `create-scaffold.test.ts` asserts the file exists in both trees (grep-level,
red-first), and T3b asserts it answers 200 **on the compiled binary**.

**T3b (the smoke).** A post-compile gate that boots the artifact and asserts the RuntimeContract:
1. binary boots and prints `LISTENING:<port> METRICS:<port>` within a budget (**15 s**, an order of
   magnitude above the 61 ms claim, so it fails on breakage not on jitter);
2. `GET <probe path>` → **200** — the operator's default path, resolved from the same source the
   operator uses, not a literal, so a future default change cannot desync the smoke;
3. `GET :9091/metrics` → 200 with `knext_bunexec_process_uptime_seconds` present (ties the smoke to
   D1's metric contract rather than duplicating it);
4. `SIGTERM` → exits **0** within `SHUTDOWN_GRACE_MS`, drain markers in order;
5. exit code, never output-grep (`mutation-harness-exit-codes` precedent).

**The darwin-host / linux-binary problem, and its answer.** `vinext-build.ts:84-121` builds
`bun build --compile --target=<triple>`, and the arch "defaults to the ship target" — so on a darwin
dev host the default invocation produces a **linux** binary that cannot be executed to be smoked.
Design:
- the smoke passes the **host** arch explicitly (the CLI already takes `arch`), so locally it boots
  a native binary; on CI (linux) host == ship target and the same code path runs;
- the **cross-target** artifact is smoked where it can be: the existing alpine docker e2e;
- it must **fail, never skip**, when it cannot boot — mirror `KNEXT_REQUIRE_STANDALONE=1`
  (`sigterm-drain-e2e.test.ts:168-174`) with `KNEXT_REQUIRE_SMOKE=1` in CI. A skip-on-can't-boot is
  the green-while-inert shape this sprint is meant to be closing.

Blast radius: 2 templates + one new CI job + `scripts/`. Edge: **T3a before T3b** (else T3b's first
run is red for a reason it should instead be *reporting*). Independent of T1/T2.

---

## T4 — One drain gate per shipping runtime, and pin the copies — but reconcile the drift first

### The drift is functional now, not "a header comment"

Measured at `d07e977f` against `turbo/generators/templates/zone/knext-bun-entry.mjs.hbs`:

| copy | diff | class |
|---|---|---|
| `packages/kn-next/templates/app/knext-bun-entry.mjs.hbs` | **0 lines** | byte-identical |
| `examples/bun-exec/knext-bun-entry.mjs` | 13 lines | the header block only — still cosmetic |
| `apps/docs/knext-bun-entry.mjs` | 47 lines | **+ image-optimization middleware** |
| `apps/file-manager/knext-bun-entry.mjs` | 56 lines | **+ image optimization + `sharp` direct-pass** |

So "pin the three app copies to the templates" as written at close is now **wrong**: two of them
carry a capability the templates do not. The finding underneath is bigger than the pin:

> **The templates ship no `/_next/image` interception, so every scaffolded app loses image
> optimization** — which `CLAUDE.md` §9 records as RESOLVED per ADR-0006. It is resolved for this
> repo's own apps and unshipped for generated ones. Same class as #895 and T3a. Third instance.

And a latent one worth exactly one measurement: `apps/docs`' copy calls `handleImageRequest`
**without** the `sharp` direct-pass that `apps/file-manager`'s copy documents as *"the only thing
that works in the compiled binary, where the optimizer's own runtime resolve cannot"*. If that
comment is right, docs' image optimization is dead inside its own binary and nothing reports it.

**T4a.** Promote the image-optimization middleware (with the `sharp` direct-pass) into both
templates; reduce all three app copies to template + header. Exit: `create-scaffold-parity.test.ts`
`VERBATIM` extended to cover the **three checked-in app copies** — a scan over "every
`knext-bun-entry.mjs` / `runtime-contract.mjs` in the tree" with an allowed header delta, never an
enumerated list of three paths (enumeration is how the fourth copy gets missed). Mutation: add a
line to one copy, the guard reds.

**T4b (drain gates).** One green, mutation-proved gate per shipping runtime:
- binary: add the **hardcap** case (exit-1 / force-stop) to the alpine e2e — at close only
  `s.stop()`→`s.stop(true)` was proved and only in a commit message;
- legacy `node-server`: the gate is green again at the tip via `bun pm pack` + `npm install`
  (`sigterm-drain-e2e.test.ts:199-258`) — its residual failure modes are T6a;
- commit **both** mutations as `scripts/mutation-prove-sigterm-*.mjs` under the existing glob
  (`run-mutation-provers.mjs:42` discovers by glob — no registration to forget).

Blast radius: templates + 3 app copies + `scripts/` + the alpine e2e. **T4a is a prerequisite of
T1** (the cap lands in the entry) and should be the sprint's *first* merge.

---

## T5 — Residuals (§4.2 leftovers, the coverage exception, #904)

Verified at the tip: `node-compile-cache.test.ts` and `bun-portability.test.ts` are **gone** (rows
closed). Still open, all cheap, one team, one PR:

- `apps/file-manager/scripts/compat-smoke.mjs:53-54` — default `SERVER_PATH` is still the standalone
  `server.js`; masked only because `ci.yml` always overrides. Its error text at `:264-265` still
  names `pnpm`, deleted this sprint. Fix: default to the compiled binary; keep the standalone path
  reachable only via an explicit env.
- `packages/kn-next/src/cli/validate.ts:55-56` — "with only `turbopack` available today", contradicted
  by `:71` in the same file, which defaults `build` to `vinext`. Fix the comment **or** delete the
  check: it is exported-and-unreachable by its own admission, i.e. decoration.
- **Coverage branch/statement loss → a dated exception.** Per the architect's E3: global `statements`
  (77) and `branches` (70) and per-package `statements` (88) / `branches` (80) were **dropped**, not
  re-baselined — branch coverage is now gated nowhere. Record it in ADR-0044's Decision-4 style:
  dated, named owner, explicit re-raise condition ("when the bun runner emits `BRDA`/`BRF`/`BRH`, or
  when a vitest leg is restored for branch data only"), **not** a config comment. And pin the current
  values — `coverage-gate.test.ts:211-214` asserts only `lines >= 70` + `per-package >= global`, so a
  silent 77→70 drop stays green today.
- **#904 undici** — `undici@7.28.0` HIGH, fixed in 7.29.0; `examples/bun-exec`'s closure gate reds on
  the next grype DB refresh. Identical shape to the picomatch pin (`3394a1fc`): an `overrides` entry
  (`"undici": ">=7.29.0 <8"`) in the owning manifest + a lockfile regeneration, which is what the
  single-package-manager move unblocked — the `workspace:` protocol packing fix at `d07e977f` is what
  makes a clean regeneration reproducible now. **Verify by regenerating, do not assume**: if undici
  arrives only transitively, the override must name the version line the way the nanoid entry does.

---

## T6 — New failure modes found at the tip (hunted, not listed)

**T6a — the `bun pm pack` `beforeAll` has a silent-substitution failure mode.**
`apps/file-manager/sigterm-drain-e2e.test.ts:199-258`: three workspace packages are packed with
`bun pm pack` (which rewrites `workspace:^` to a concrete version) and installed with
`npm install --omit=dev <tarballs>`. Two consequences:
1. **It reaches the public registry.** `--omit=dev` still resolves `@getknext/core`'s prod deps
   (prom-client, pino) from npm. A registry incident reds a `security.md` runtime-hardening gate on
   every PR — a network dependency inside a fail-closed security gate.
2. **Worse: a version-skew substitution.** If a changeset bumps `core` but not `lib`, the rewritten
   range may not be satisfied by the *local* lib tarball, and npm will silently fetch the
   **published** lib instead. The assertion at `:246-252` only checks that files exist, so the gate
   goes green while proving the shipped supervisor against a stale published dependency.
   Fix: `--install-strategy=nested` is not the answer; assert **provenance** — after install, read
   `node_modules/@getknext/lib/package.json`'s version and assert it equals the workspace version,
   and add `--ignore-scripts`. Cheap, and it converts a silent substitution into a red.
   Minor: if `bun pm pack` throws, the `packDirs` created above it leak (the `rmSync` loop is below
   the throw) — wrap in `try/finally`, same shape as the fix already applied to `uploadAssets`
   (`asset-upload.ts:654-662`, which **closed** the temp-dir leak I filed at close; that row is done).

**T6b — `KNEXT_TEST_SEAMS`: the gate is right, the surface is still wrong.**
`cache-handler.js:156-163` now fails closed on the two mutating seams — the correct answer to the
architect's BLOCK 1. But the gate is an **env var on a published module**
(`@getknext/core/adapters/cache-handler`, a public subpath). Anything that can set an env var in the
app's process — an npm postinstall, a compromised transitive dep, a Dockerfile `ENV` copied from a
blog post — re-opens `__setRedisClientForTests(null)` and silently disables the process-wide cache.
Smallest sound fix, and the architect already named it: a **scan** asserting no `__`-prefixed
identifier survives in any public subpath's `dist`, with the seams moved to a test-only entry.
Until that lands, add the cheap half: make the thrown error also fire when `NODE_ENV === 'production'`
**regardless** of the flag, so the flag cannot re-enable it in a production process at all.

**T6c — `singleExec` is a string-identity test.**
`compat-smoke.mjs:60` — `const singleExec = SERVER_CMD === SERVER_PATH`. Both are env-overridable.
A relative-vs-absolute path, a symlink, or a trailing slash makes two spellings of the same file
compare unequal, and the runner then takes the standalone branch: it stages
(`:280-296`), spawns with a preload arg (`:298-302`), and check (h) re-enters the `--version` probe
that boots a second server (the hang I measured at close — the fix at `:471` is guarded by exactly
this boolean). Fix: derive the mode from an explicit `SMOKE_MODE=single-exec`, or compare
`realpathSync` of both, and **assert the two agree** so a disagreement is a loud failure rather than
a silent mode flip. One line, and it protects the fix that was just made.

**T6d — `apps/docs`' image optimizer has no `sharp` direct-pass** (see T4). One measurement:
`GET /_next/image?...&w=…` with `Accept: image/webp` against the docs binary; if the response is
byte-identical to the source, docs has been shipping unoptimized images since the intercept landed.

---

## Ordering constraints (the edges that matter)

```
T4a (reconcile + pin the entry copies)  ──►  T1 (byte cap)        ──► ADR-0044 Am.4
        │                                     │
        └──────────────────────────────────►  T4b (drain gates)
T3a (health route in templates)  ──►  T3b (#894 post-compile smoke)
T2a (generateBuildId + re-pointed guard)  ──►  T2b (marker, #892)  ──►  T2c (reclaim test)
                                          └─►  T2d (CR env)
T5, T6a-d: independent, any order
```

- **T4a is the sprint's first merge.** Five copies of the entry exist; T1 and T4b both edit it.
  Landing either first guarantees a five-way drift.
- **T2a strictly before T2b.** Unchanged from close, now for a sharper reason: the inertness is the
  only thing preventing an over-delete, and marking before marker-key ≡ protection-key *is* the
  over-delete.
- **T3a strictly before T3b**, so the smoke's first run reports rather than reds.
- **T1's experiment before T1's code.** If Bun's cap trusts `Content-Length`, T1 is a different task
  with a different blast radius, and finding that out after the entry is edited wastes the sprint's
  cheapest win.
- **Disjoint radii hold**: T1+T4 own `knext-bun-entry.mjs*`; T2 owns `cli/` + `asset-upload.ts`;
  T3 owns the template app tree + a new CI job; T5/T6 own leaves. One worktree each, per
  `workflow.md`.
- **Triggers to acknowledge up front, not at close**: T2 touches `packages/kn-next/src/cli/`
  (mechanical, fires). T1 does **not** touch the CRD or `config.ts` by design — if anyone proposes
  the `spec.security.ingress.*` field mid-sprint, that is an escalation, not a scope tweak.

---

## The three things sprint 2 must not ship without

1. **The byte cap actually enforced on the shipped binary, with the chunked-encoding case proved.**
   ADR-0044's exception has now survived two re-anchorings; the fix is ~4 lines and one experiment.
   Renewing a security exception a third time when the control costs a flag is not a trade, it is a
   decision to ship without the control — which is this ADR's own architect gate's words.
2. **A scaffolded app that boots, goes Ready, optimizes images, and caches ISR.** Three of the four
   are broken or absent in the templates *right now* (health route, image optimization, and — fixed
   only this sprint — the cache handler), and each was found by reading the templates rather than by
   any gate. T3a + T4a + T3b, together, are the gate that stops the fourth instance.
3. **The id flow closed end to end — mint → `generateBuildId` → marker → label → prune → reclaim —
   with the lock-step guard failing loudly instead of skipping.** Skew protection is currently a
   warning printed on every deploy; a guard that skips every run is indistinguishable from no guard,
   and the assets it is supposed to protect are being over-kept forever.

**One thing I will not carry silently.** My close said someone has to own "is the stack green"
continuously. Nothing in this plan does that, because it is not a design task. If sprint 2 ends with
this stack still unmerged, T1's clock (ADR-0044 Amendment 2) has failed twice, and the honest move at
that close is a founder-approved time-boxed backstop — not a third re-anchor.
