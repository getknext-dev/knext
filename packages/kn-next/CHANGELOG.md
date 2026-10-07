# @getknext/core

## 1.3.0-rc.6

### Patch Changes

- 17b268f: `knext doctor` now warns, instead of failing, when the installed CRD lacks only fields the CLI emits for a specific feature (`spec.security.writeFree` for CLI-built images, `spec.networking` for private apps), and names the feature. A missing always-emitted field still fails.
- 313f897: Bundled vinext fix: `/_next/image` responses now carry `x-nextjs-cache: MISS` on every successful image response, like Next.js. Error responses carry no header.
- 35f4d48: The Bun single-executable build now writes the HarfBuzz and harfbuzzjs licence notice (`knext-third-party-notices.txt`) beside the binary whenever it embeds `hb.wasm` for `next/og`, and the generated Dockerfiles copy it into the image.
- 546cad0: `knext deploy --dry-run` now writes its log lines to stderr, so stdout carries only the rendered `NextApp` YAML and `knext deploy --dry-run | kubectl apply -f -` works. `knext db bind --dry-run` does the same for the patch it prints.
- 622f728: The vinext cache adapter now picks its Redis client per runtime, like the standalone build. New `@getknext/core/internal/vinext-cache-adapter-node` imports `ioredis` directly so a vinext on Node image ships it (it could previously run from memory, losing ISR on scale-to-zero), and `@getknext/core/internal/vinext-cache-adapter-bun` uses Bun's built-in Redis client. New apps are scaffolded with the one matching their runtime; existing apps can switch the specifier in `vite.config.ts`. The generic subpath keeps working. If `REDIS_URL` is set but the client cannot load, startup logs one error.

## 1.3.0-rc.5

### Patch Changes

- 3a846a5: `knext build` now stages the standalone docker build context (`Dockerfile.standalone` and the entry shims) for the Node and Bun targets, the same files `knext deploy` stages, and prints the context path and build command, so the image can be built on a remote builder.
- c22b079: `knext deploy --image <ref>@sha256:...` no longer fails on the scaffold's placeholder `registry` value. Nothing is built or pushed with a pre-built image, so the registry is not needed; every other placeholder (storage bucket, domains) still fails fast.
- 4ef2382: `knext deploy` now honours `KN_REDIS_URL` before validating the config: it overrides the redis `cache.url`, including an empty one. Previously the override was applied after validation, so a deploy with only `KN_REDIS_URL` set was refused. The error for a missing URL now names both `REDIS_URL` and `KN_REDIS_URL`. `knext preview` now also applies `KN_REDIS_URL`; before, it ignored it.
- 91f2150: The operator now warns when a Knative `DomainMapping` targets a private (cluster-local) app. Knative routes a `DomainMapping` through the public load balancer even when the mapping is labelled cluster-local, so the app silently becomes reachable from the internet. The app now carries a `PrivateExposure` condition and a Warning event naming the mapping. `Ready` is unchanged and the operator never modifies or deletes the `DomainMapping`. Upgrade the operator (its RBAC gains read access to `domainmappings`) before relying on it. The private-apps docs now explain how to expose a private app safely.
- 4f3712e: `next/og` `ImageResponse` now works on the vinext target with `@vercel/og` 1.x (the version vinext pins), on both the Bun compiled executable and Node.js, in pages API routes, app route handlers (Edge or Node.js runtime) and middleware. The build ships the HarfBuzz `hb.wasm` binary from the exact `satori` → `harfbuzzjs` versions `@vercel/og` was built against: it is embedded in the Bun executable, and staged into `.output/server` with its MIT licence for Node.js. OG image routes no longer answer 500 or drop the connection with `ENOENT … hb.wasm`. When those versions do not match, the build prints a `WARNING: next/og will fail at runtime` line, and fails instead under `KNEXT_COMPILE_STRICT_REQUIRES=1` on either runtime (or a `--self-contained` Bun build).
- 81329bb: The CRD-schema preflight now names only the unknown fields present in the NextApp CR being applied, not every field this CLI version can emit. A `--private` deploy against an older operator no longer also blames `spec.security.writeFree` when the CR carries no such field.

## 1.3.0-rc.4

### Patch Changes

- 3c2348f: A private preview can now be made public by changing the branch's config. Setting
  `networking: { visibility: "public" }` explicitly in `knext.config.ts` is accepted on the next
  preview deploy; omitting the `networking` block is still refused so an accidental removal cannot
  quietly expose a private preview. The refusal message now names both ways forward.
- e1a5269: `knext build` no longer fails with "'cache.url' is required" for a Redis-cache app when `REDIS_URL` is not set at build time. The URL is now required only at `knext deploy`, and the error says to set `REDIS_URL` when you deploy.
- e0238ad: ISR pages generated at request time (for example a dynamic route without `generateStaticParams`) are
  no longer served as stale on the first request after the app scales up from zero. The Redis cache
  handler now records which build wrote each entry, along with its revalidate window, and gives that
  window back to Next.js when the same build reads the entry. A cached page inside its window is then
  a cache hit after a cold start instead of triggering a regeneration. Entries written by a previous
  deploy are still revalidated by the new build as before.

## 1.3.0-rc.3

### Minor Changes

- 1d06599: Add a `networking.visibility` option to `knext.config.ts` and a matching `knext deploy --private`
  flag, so an app can be deployed with its route reachable only from inside the cluster instead of
  always getting a public one. This is the platform way to deploy an app whose mutating endpoints
  (uploads, deletes, admin actions) have no auth of their own, without relying on a manual label the
  next deploy would silently undo.
  
  Leaving `networking` unset keeps today's behavior exactly — a public route, as before. Requires an
  operator (and its CRD) that supports this field; upgrade the operator before deploying with a CLI
  that sets it, or the deploy is rejected with a clear schema error. See the "Private apps" docs page
  for how to deploy one and how to reach it afterward.
  
  `--private` is a per-run override, not a persistent setting, so a later plain `knext deploy` with
  no flag now REFUSES to silently make a currently-private app public again — it names the new
  `knext deploy --public` flag as the only way to confirm that downgrade. The same guard now covers
  preview deploys too (the `preview.js deploy` entry), which reuse one CR name across every commit of a PR: previews have no
  `--public` override, so an accidental downgrade is fixed with a `knext.config.ts` change on that PR's branch, and a private preview that should become public is removed first and then redeployed.
  
  Also: `knext deploy --image <ref>` (deploying a pre-built, digest-pinned image) no longer requires
  a lockfile in the current directory. It already skipped the build; it was incorrectly still
  checking for one first.

### Patch Changes

- e46b37a: Bundles a fix ahead of its upstream vinext release (`cloudflare/vinext#3689`):
  when a server action's `redirect()` is invoked through the client-side router
  (a fetch request, not a plain `<form>` submission), the response now always
  answers HTTP `200`, matching current Next.js. It previously fell back to
  `303` unless the redirect target had already been forwarded, was an
  ancestor/stale-sibling route, or ran on a different runtime than the current
  route.
  
  This only changes the response's status code — the redirect target still
  reaches the browser the same way it always did, through the
  `x-action-redirect` header (no `Location` header is set either before or
  after this fix), so no open-redirect behaviour is introduced. A no-JS
  `<form>` submission's redirect is unaffected and still answers `303`.
- b167fd4: Fixed a cold-start regression on the vinext build target (both the compiled single-executable and the Node runtime): on some clusters, apps deployed with `build: 'vinext'` woke up to around 8 seconds slower than the standalone target, because the networking-stall mitigation described in the scale-to-zero docs was not wired into this build target. It now sends the same best-effort outbound packet as early as possible at process start, like every other knext runtime. The compiled executable picks it up on rebuild; a vinext app on the Node runtime also needs the new `knext-node-entry.mjs` from a freshly created app copied in (`knext doctor` reports a stale one). Opt out with `KNEXT_ARP_PRIMER=0` if you need to.
- ee45ef3: Fixes `next/og`'s `ImageResponse` (e.g. a dynamic `opengraph-image` route)
  answering a 500 error when built as a `bun build --compile --bytecode`
  single executable (the `vinext` build target's compiled-binary shape). It
  previously failed every time with `ENOENT`, because the compiled binary
  looked for the image renderer's WASM and fallback-font files at a path that
  only ever existed on the machine that built it. `ImageResponse` now works
  the same way in the compiled binary as it does uncompiled.
  
  **Note:** `vinext` 1.0.1 installs `@vercel/og` 1.0.3, whose published
  package is missing one of its WebAssembly files. `vinext` works around that
  itself, but in this build Nitro keeps `@vercel/og` as an external package,
  which bypasses that workaround, so `next/og` answers a 500 error (compiled or
  not). Apps created with `knext create --builder vinext` now pin `@vercel/og`
  to `0.11.1` through an `overrides` entry in `package.json`. An existing app
  adds the same entry by hand:
  
  ```json
  {
    "overrides": {
      "@vercel/og": "0.11.1"
    }
  }
  ```
  
  `package.json` is plain JSON and cannot carry a comment, so the reason for the
  pin lives here and in the build-pipeline docs. Remove the entry once a `vinext`
  release ships a working `@vercel/og`.
- 0cddde7: Fixed a `build: 'vinext'` + `runtime: 'node'` image build failure after the documented `npm install` step: `knext build`/`knext deploy` could not stage sharp's native addon for the deployed image unless the app also had a `bun.lock`, so an app installed with plain `npm install` (no bun involved at all, which is the normal case for a `--runtime node` app) failed with sharp's own "Could not load the sharp module using the linuxmusl-x64 runtime" during the image build. The staging step now also reads npm's `package-lock.json`, so `npm install` is sufficient — Node remains a first-class option alongside Bun. No action needed; rebuild and redeploy to pick up the fix.
- 598441e: `knext create --builder vinext` now pins `@vercel/og` to `0.11.1` through an
  `overrides` entry in the generated `package.json`, so `next/og`'s
  `ImageResponse` (for example a dynamic `opengraph-image` route) renders in a
  new app on both the Bun and Node runtimes without manual setup. Without the
  pin, `vinext` 1.0.1 installs `@vercel/og` 1.0.3, which answers a 500 error in
  this build. Apps created before this change add the entry by hand; see the
  build-pipeline docs. Other builders are unchanged.
- b679600: Fixed `npm install` failing in every new app created with `knext create --builder vinext` (React
  Compiler is on by default). `@vitejs/plugin-react` 6.1.2, published on 2026-10-05, requires a newer
  `oxc-transform-react` than the scaffold pinned, so npm refused to install with an `ERESOLVE` peer
  dependency error. New vinext scaffolds now pin `@vitejs/plugin-react` to exactly `6.1.2` and
  `oxc-transform-react` to `^0.152.0`, so the two only change together.
  
  An existing vinext app that hits the error updates the same two `devDependencies` in its
  `package.json`:
  
  ```json
  {
    "devDependencies": {
      "@vitejs/plugin-react": "6.1.2",
      "oxc-transform-react": "^0.152.0"
    }
  }
  ```
- @getknext/db@1.3.0-rc.3
  - @getknext/lib@1.3.0-rc.3

## 1.3.0-rc.2

### Minor Changes

- 3823881: `knext create` now asks for the runtime (`bun` or `node`), builder (`turbopack`, `webpack` or
  `vinext`), ISR/data cache (`none` or `redis`), object storage provider and React Compiler when it
  runs on a terminal with no flags. Each question has a flag (`--runtime`, `--builder`, `--cache`,
  `--storage`, `--react-compiler`), and `--yes` skips them all. With any flag, `CI` set, or no
  terminal, it asks nothing and uses the defaults, which scaffold exactly the same app as before.
  
  Choosing `node` adds `ioredis` to the app's dependencies, at the same range `@getknext/core` uses.
  A Bun app gets nothing extra, because Bun has a Redis client built in.
  `--builder` now accepts `turbopack` and `webpack`; `default` still works and means `turbopack`.
  
  New apps now have React Compiler turned on by default, on every builder. On turbopack/webpack,
  `next.config.ts` gets `reactCompiler: true` and `babel-plugin-react-compiler`. On vinext,
  `vite.config.ts` gets `react: { compiler: true }` plus the four packages it needs. Pass
  `--no-react-compiler` (or answer `n`) to leave it off, which scaffolds exactly the same app as
  before.
- c0a664c: Cold start: apps with object storage, and vinext apps, no longer need a writable volume.
  
  Each writable `emptyDir` the operator mounts costs pod-sandbox setup time on every scale-from-zero wake. Two app shapes still got one by default; they no longer need it:
  
  - **Standalone apps with `storage` configured.** The knext adapter now sets Next's official `images.customCacheHandler` option when the app uses the knext cache handler, so optimized `next/image` variants are stored through the cache handler instead of `.next/cache/images` on local disk: on the Bun runtime with Redis configured, in Redis (shared across pods and kept across scale-to-zero). Otherwise they go in a per-pod in-memory cache capped at 32 MiB (`KNEXT_IMAGE_CACHE_MEMORY_BYTES`). That includes the Node runtime for now: its standalone image cannot reach Redis yet, so it falls back to the memory cache and re-optimizes variants after each scale-to-zero. Set `KNEXT_IMAGE_CACHE_HANDLER=0` at build time to keep Next's disk cache. The object-storage image sync now stands down when images are stored through the cache handler, or when its directory is not writable, instead of erroring on every wake.
  - **vinext apps built as a disk-mode binary** (the default). sharp loads from the image's read-only `native/` directory, so nothing is written at runtime.
  
  `knext deploy` now sets a new optional `NextApp` field, `spec.security.writeFree: true`, for an image it built in the same run when that image writes nothing to local disk. The operator then renders no writable volume at all, with `readOnlyRootFilesystem` still on. The CLI sets it only when it changes the result, so a standalone app without storage gets the same `NextApp` as before. It is never set for `--image` / `--skip-build` deploys or for self-contained vinext binaries, which still unpack sharp into `/tmp`. `spec.security.writableCache: true` still mounts both writable paths.
  
  **Upgrade order:** upgrade the operator (and its CRD) before the CLI. A CLI that sets `spec.security.writeFree` against an older CRD fails the deploy preflight with `unknown field "spec.security.writeFree"`.

### Patch Changes

- 942ad38: Node runtime: the ISR and data cache now uses Redis when Redis is configured.
  
  On the standalone node runtime, the image did not include the Redis client. The cache handler fell back to an in-memory store without saying so: cache entries were not shared between pods and were lost on every scale-to-zero. The bun runtime was not affected.
  
  The cache handler now has one entry per runtime, and `knext build`, `knext deploy` and `knext preview` pick the entry that matches your configured runtime. On node it uses `ioredis`, which the build now copies into the image. On bun it uses Bun's built-in Redis client. Also, if Redis is configured but its client cannot be loaded, the handler now logs one error at startup, starting with `Redis client unavailable`, instead of quietly running from memory.
- 5b1717d: Remove `scaling.containerConcurrency: 100` from the scaffold templates used by `knext create`
  (both the standalone/turbopack and vinext builder templates). The operator's default of `20`
  now applies, which is the concurrency the 8 MiB request-body cap is sized for — at `100`,
  concurrent large uploads could buffer enough bytes to OOM-kill a 1Gi pod.
  
  Apps created before this change contain the `containerConcurrency: 100` line in their
  `knext.config.ts`; delete it, or set it to `20` or lower.
- 5dece2e: Fixed a regression in the bundled vinext fix for Nitro RSC dependency bundling (the
  port of upstream `cloudflare/vinext#3424`): under the vinext/bun compiled-executable
  build target, two deploy-test fixtures measured with 1.3.0-rc.1 broke because the
  blanket bundling also swept Next's default server-external packages (including
  sqlite3's `bindings` helper and typescript) into the compiled binary. Those packages
  now stay external under Nitro too, matching the non-Nitro RSC branch's behaviour, so
  the original fix (dependencies of the RSC environment are bundled so a package's
  `react-server` export condition is honoured) no longer bundles packages that are not
  safe to inline.
  
  Also adds an optional `testFiles` `workflow_dispatch` input to the
  `compat-vinext.yml` CI lane for a targeted re-run of specific test files, instead of
  waiting on a full 16-shard dispatch. Default is empty, which is unchanged behaviour.
- 678d1da: Bundles 4 small vinext fixes ahead of their upstream release, each ported as its own
  upstream PR against `cloudflare/vinext`:
  
  - `experimental.lightningCssFeatures.include`'s `custom-media-queries` entry now also
    turns on lightningcss's `drafts.customMedia` parser flag, so a stylesheet using
    `@custom-media` builds instead of failing to parse (`cloudflare/vinext#3681`).
  - App Router: a GET/HEAD request for an unmatched path whose `Sec-Fetch-Dest` is a
    non-HTML subresource destination (image, font, script, manifest, ...) now gets the
    same plain-text 404 an invalid `_next/static/*` request already gets, instead of
    compiling and rendering the full custom not-found page
    (`cloudflare/vinext#3682`).
  - A route whose resolved `runtime` is `edge`/`experimental-edge` now prints the "Edge
    Runtime is deprecated" warning once per build/dev session, matching Next.js
    (`cloudflare/vinext#3683`).
  - A bare `//` (literal or percent-encoded, with nothing after it) in a request path is
    no longer treated as an open-redirect shape and 404'd; it now serves the index route,
    matching Next.js (`cloudflare/vinext#3684`).
  
  All 4 patches are runtime-agnostic (they also help a future vinext x node lane, not
  just vinext x bun) and ship with their own behaviour test against the patched dist.
- 70c5bbd: Bundles a fix for `next/image` ahead of its upstream vinext release
  (`cloudflare/vinext#3686`): the image optimization endpoint now honours
  `trailingSlash: true` (previously always `/_next/image?...`, never
  `/_next/image/?...`), and a custom `loader` prop now gets the same
  per-breakpoint `srcSet` treatment as the built-in loader — the loader is
  called once per responsive width instead of once at the raw intrinsic
  width, and `quality` is passed through as given instead of being forced
  to 75.
  
  Not yet bundled: the upstream fix also wires up `images.loaderFile`
  (previously silently ignored); that part needs vinext's own build
  pipeline to resolve and isn't a knext-side patch, so `images.loaderFile`
  remains ignored until the upstream release.
- 24543bb: Bundles two fixes ahead of their upstream vinext releases:
  
  `cloudflare/vinext#3687`: a `next.config.js`/`.ts` exported as a function
  now receives the real `defaultConfig.pageExtensions` (matching Next.js's
  own default) instead of an empty object — a config that reads
  `defaultConfig.pageExtensions` (e.g. to append a custom page extension)
  previously threw `defaultConfig.pageExtensions is not iterable` at build
  time.
  
  `cloudflare/vinext#3688`: a module that starts with a hashbang line
  (`#!/usr/bin/env node`) and also uses CommonJS syntax (`module.exports`,
  `require(...)`) no longer fails to build. The CommonJS-to-ESM interop
  transform used to prepend its runtime facade before the hashbang, pushing
  `#!` out of the first two bytes of the file and causing the bundler to
  reject it as invalid syntax; the hashbang is now stripped before that
  transform runs and spliced back onto its output.
- @getknext/db@1.3.0-rc.2
  - @getknext/lib@1.3.0-rc.2

## 1.3.0-rc.1

### Minor Changes

- e5d94c6: Add an opt-in, experimental patched Bun toolchain for the compiled vinext
  executable: `compile: { bun: "knext-patched" }` in `knext.config.ts`.
  `knext build` downloads a knext-published Bun 1.4.2 build that adds
  `--compile --include` (Linux glibc x64 and arm64 build hosts), verifies it
  against a sha256 pinned in this package, and fails the build on any mismatch
  rather than falling back to stock Bun. `compile.include` keeps its meaning and
  every safety check; with the patched toolchain the same checked files are
  embedded through Bun's native `--include`, at the same paths. `compile.include`
  now also refuses native addons (`.node`) with a clear message, in both modes.
  The default (no `compile.bun`) is unchanged.
- 51fbd7e: Add `compile.include` (experimental) for the compiled vinext executable:
  `compile: { include: ["plugins/*.js"] }` in `knext.config.ts` embeds the
  matching JavaScript/TypeScript modules in the executable, where they load on
  their first import from `/$bunfs/root/<path relative to the app root>` — not
  at startup, and with nothing beside the binary. Works on stock Bun. A pattern
  that matches nothing, a non-module match, or use on another build target fails
  the build or the config check.
- 02f24e3: Bundle six vinext fixes ahead of their upstream release. A new
  `knext vinext-patches` command applies them to the app's installed vinext
  (1.0.1 only — any other version is left untouched); vinext apps created by
  `knext create` run it from `postinstall` (a no-op when `@getknext/core` is not
  installed, e.g. `npm ci --omit=dev`), and `knext build` re-applies it before
  the vinext build. Each fix applies all-or-nothing; `KNEXT_VINEXT_PATCHES=0`
  turns them all off. Fixes: Pages Router `/_next/data` requests see the original
  URL as `req.url`; `require()` of CommonJS dependencies picks the `require`
  export condition; `turbopack.resolveExtensions` without `.mjs` no longer breaks
  the Nitro build; RSC dependencies are bundled so `react-server` export
  conditions apply; Web Workers get `NEXT_DEPLOYMENT_ID` inlined; and
  `outputFileTracingIncludes`/`Excludes` reach Nitro's dependency trace.

### Patch Changes

- 1aa6b8f: knext's public docs site moved from `knext.dev` to `knext-platform.dev` (`knext.dev` now resolves to an unrelated Cloudflare 403 page). Updates every user-facing `knext.dev` URL in the CLI — help text (`knext --help`), error-message hints (`knext doctor`, missing-config guidance), scaffolded `knext.config.ts` template comments, the asset-upload multi-cloud hint, and package READMEs (`@getknext/core`, `@getknext/lib`, `@getknext/db`, the `kn-next` alias package) — to `knext-platform.dev`. `@getknext/action`'s README is also updated but carries no changeset entry since that package is `private: true` and never publishes. Kubernetes label keys that happen to share the domain string (e.g. the CRD-adjacent `apps.knext.dev/build-id` label) are unaffected; they are not web links.
- 4945b10: Fixed `knext build --builder vinext` (default `runtime: bun`) failing its post-compile smoke on glibc Linux hosts (e.g. GitHub-hosted `ubuntu-latest` runners, or most Linux dev machines) for any app that depends on `sharp` — which every app `knext create --builder vinext` scaffolds does, for `next/image`. The smoke-only glibc twin binary the smoke compiles for that host now stages sharp's real glibc native addon pair before boot, the same way the shipped `linuxmusl` binary already stages its own (fetched from the lockfile-pinned version when the build host's own install does not carry it). The shipped binary's own sharp staging is unaffected and still verified by the alpine image e2e.
- 056432d: Bump the scaffolded app's `vinext` pin from `1.0.0-beta.12` to the first stable
  release, `1.0.1` (peer ranges unchanged). Apps generated with `kn-next create
  --builder vinext` now install vinext `1.0.1`. The compat lane's own deploy
  script (`scripts/e2e-deploy-vinext.sh`) stays on `1.0.0-beta.12` for now — it
  is inside the v1.0.0-rc.5 credential freeze window and will follow once that
  window closes.
- Updated dependencies [1aa6b8f]
  - @getknext/lib@1.3.0-rc.1
  - @getknext/db@1.3.0-rc.1

## 1.0.0-rc.5

### Patch Changes

- 13780ff: Send one best-effort outbound UDP datagram to the pod's default gateway as early as possible at process start, in both runtime entries (the standalone supervisor and the compiled standalone-on-Bun executable). On some clusters a node can briefly be unable to reach a freshly-started pod until it sends its own first outbound packet; this mitigates the resulting cold-start stall without requiring any extra cluster privilege or feature flag. Opt out with `KNEXT_ARP_PRIMER=0`.
- f89e9db: Cold-start fix: the operator no longer mounts an `emptyDir` volume by default under `readOnlyRootFilesystem: true` for a standalone app with no object storage configured — provisioning that volume cost pod-sandbox setup time on every scale-from-zero wake whether or not anything was ever written to it. `readOnlyRootFilesystem` stays on by default.
  
  Two writes stay mounted unconditionally, by default, because they are not optional for the shape that needs them: `/tmp` for any self-contained single-executable build (`build: vinext`, or `selfContained: true`), and Next's image-optimizer cache directory for a standalone app with `spec.storage` configured. A new, additive opt-in field, `spec.security.writableCache`, restores the pre-existing unconditional mounts for an app that wants guaranteed local writes outside those two cases.
  
  (A companion change raising the default CPU limit was evaluated and reverted after review — it risked silent `FailedCreate` rejections on clusters with a `LimitRange`. The default CPU limit stays `1000m`; see `docs/operator/scaling-cold-start.md` for the opt-in recipe.)
  
  **Upgrade note:** standalone apps no longer get a writable `/tmp` (or `.next/cache`) by default. If your app code writes to `os.tmpdir()` or another path at runtime, set `spec.security.writableCache: true` before upgrading. Apps with `spec.storage` configured keep `.next/cache`, and single-executable builds keep `/tmp`.
- da92b15: `knext create`: the scaffolded `src/instrumentation.ts` now checks the tracing switch (`OTEL_TRACING_ENABLED=true`) before it imports `src/instrumentation-node.ts`. With tracing off, which is the default, the app no longer loads the OpenTelemetry, metrics and client modules at startup, so cold starts are faster. On GKE e2-standard-4 nodes with a 1-CPU limit and pre-pulled images, the median scale-from-zero first request dropped by about 0.9 s on Bun and 0.8 s on Node. With tracing on, the app loads the same modules and registers the same span processors as before. Apps created earlier can copy the change by hand; the observability docs show how.
- d972995: The compiled standalone-on-Bun build's disk-closure scan now logs a warning (once per distinct specifier) when a module a route chunk requires cannot be resolved under either the `require` or ESM/`default` export condition, instead of silently dropping it. The warning names the specifier, the directory it was required from, and both resolution attempts' errors.
- Updated dependencies [65eef13]
  - @getknext/lib@1.0.0-rc.5
  - @getknext/db@1.0.0-rc.5

## 1.0.0-rc.4

### Patch Changes

- 5afa5f8: Fix on-demand invalidation of statically and ISR-cached pages with the Redis cache handler. `revalidateTag` and `revalidatePath` returned success but never evicted full-route-cached pages, because Next.js stores those pages' tags (including the implicit path tags `revalidatePath` uses) in the `x-next-cache-tags` header instead of the cache-write context. The handler now indexes both, so invalidating a tag or path refreshes the cached page on the next request.
- 0a32380: Security: new apps now scaffold with Next.js 16.3.6. The default template moves from 16.3.5, and the vinext builder template from 16.3.3. Next.js 16.2.0 through 16.3.5 have a critical remote code execution vulnerability in `next/og` `ImageResponse` (GHSA-vcvr-r3jv-pc5j), fixed in 16.3.6. If you scaffolded an app from an earlier release candidate, upgrade it with `npm install next@16.3.6` (or a later 16.3.x). The compatibility credential suite now runs against Next.js 16.3.6.
  
  `@getknext/lib` depends on `@grpc/grpc-js` through `@cerbos/grpc` with a range that already admits the patched 1.14.5 (GHSA-m9gg-hp2v-232j), so a fresh install resolves the fix. If your lockfile still holds `@grpc/grpc-js` 1.14.4 or older, update it.
- Updated dependencies [0a32380]
  - @getknext/lib@1.0.0-rc.4
  - @getknext/db@1.0.0-rc.4

## 1.0.0-rc.3

### Patch Changes

- Release-candidate re-cut with no changes to package code. The compatibility credential test harness now covers the sharp version that Next.js 16.3.5 ships, so the Bun credential runs can execute against this candidate.
- Updated dependencies
  - @getknext/lib@1.0.0-rc.3
  - @getknext/db@1.0.0-rc.3

## 1.0.0-rc.2

### Minor Changes

- e36eb32: The config file is now `knext.config.ts` (was `kn-next.config.ts`). **No
  dual-read** — the CLI reads `knext.config.ts` only.
  
  If your app still has `kn-next.config.ts`, rename it before your next `knext`
  command:
  
  ```
  mv kn-next.config.ts knext.config.ts
  ```
  
  Running any `knext` command in a directory that still has the old filename
  (and no `knext.config.ts`) now fails fast with one actionable error naming
  the exact rename to make — never a silent fallback read and never a warning
  that lets an old-named config keep working.
  
  `knext create` scaffolds `knext.config.ts` for new apps. CLI messages, `doctor`
  checks, the GitHub Action, and the docs site all say `knext.config.ts`
  throughout.
- 7c9576d: Request bodies are now capped in-process on the **standalone build** too
  (Turbopack or webpack, on Node or Bun, compiled or not) — previously only the
  vinext build capped them. The default is **8 MiB** per request body, on every
  route. A larger body is answered with `413 Payload Too Large` and the connection
  is closed (after discarding, never buffering, the rest of the body for at most
  two seconds so an uploading client can read the status); the cap counts the bytes that actually arrive, so a chunked request
  with no `Content-Length` is refused too, and an oversized body never reaches
  your handler.
  
  **Behaviour change:** if your app accepts uploads larger than 8 MiB through a
  route handler, raise the cap before upgrading — set `KNEXT_MAX_REQUEST_BYTES`
  (bytes) in the `env` map of `knext.config.ts` or in `spec.env` on the
  `NextApp`. `0` removes the cap (logged loudly at start); an invalid value keeps
  the 8 MiB default with a warning. The app prints the cap in force on start:
  `REQUEST_BYTE_CAP:<bytes> (<source>)`.

### Patch Changes

- 7661878: Rewrite package READMEs for v1.0 release: concise one-paragraph introductions, quickstart commands that work, supported platforms table (Node/Bun × Turbopack/Webpack, with the Next.js versions on the compatibility page), and clear links to docs, compatibility, security, and contributing pages. Remove internal references (ADR numbers, issue/PR numbers) to prepare for npm publication.
- d845497: The standalone-node compile-cache bake no longer fails `docker build` with "standalone server did not answer" for apps whose routing redirects or rewrites the warm path. Readiness now waits for the server to accept a connection rather than for an HTTP answer through the app's middleware, redirects on the warm path are followed by hand (a redirect loop is reported as the non-2xx status it is, instead of a timeout), and the bake's own requests no longer go through the `fetch` that Next.js patches inside the server process. The bake also never follows a redirect off its own origin — a warm path that redirects to a third-party host (for example an auth middleware bouncing to an external IdP) is reported as the redirect it is, never fetched, so the bake can't be graded on a third party's response or make an unbounded outbound request during `docker build`.
- 26807fc: 1.0 contract prep: adds a frozen, machine-checked CLI contract
  (`cli/contract.ts`) covering every verb's flags and exit codes, cross-checked
  against each verb's own parser/source so a flag or exit-code change without a
  matching contract update fails a test. Documents exit codes for every verb in
  the CLI reference (previously 3 of 12); no behaviour changed.
- 28f6d66: Mark the `selfContained` config key / `knext build --self-contained` flag and
  the `preview`/`loadtest` directly-runnable CLI entries as **experimental** —
  they are excluded from the 1.0 semver commitment and may change in a minor
  release. `docs/PUBLIC_API.md` now documents this carve-out under
  "Experimental surfaces"; no behaviour changed.
- Updated dependencies [7661878]
  - @getknext/lib@1.0.0-rc.2
  - @getknext/db@1.0.0-rc.2

## 1.0.0-rc.1

### Major Changes

- First v1.0 release candidate. This major bump reflects the v1.0 credential
  milestone (ADR-0056): the fixed group (`@getknext/core`, `@getknext/lib`,
  `@getknext/db`, `kn-next`) moves from `0.x` to a `1.0.0` line, cut first as a
  release-candidate series (`1.0.0-rc.N`) while the runtime x builder cell
  matrix earns its 14-consecutive-green-night credential against a frozen RC
  tag. No breaking API change is bundled with this changeset itself — the
  major bump marks the milestone, not a compatibility break. See
  `docs/release/v1.0.0-rc.1.md` for what rc.1 covers and what remains
  rehearsal-only.

### Minor Changes

- 59ef1d9: `kn-next create` now scaffolds the **standalone target** by default (matching the CLI's own
  default build, `build: 'turbopack'`): plain `next build`, `output: 'standalone'` in
  `next.config.ts`, and the official Next.js Deployment Adapter wired through `adapterPath` via a
  generated `next-adapter.ts`. `kn-next build`/`deploy` stage the matching runtime image
  automatically, so the scaffold ships no `Dockerfile` for this target.
  
  Pass `--builder vinext` to scaffold the previous shape instead — the compiled single-executable
  target, with its own `Dockerfile`, `vite.config.ts`, and `build: 'vinext'` pinned explicitly in
  `kn-next.config.ts`. That shape is unchanged.
  
  This only affects apps scaffolded from here on; an existing app's own files are never rewritten.
- 2622780: **Existing apps without a `build` key switch builders on upgrade.** The default build target changed from `vinext` (the compiled single executable) to `turbopack` (`next build` -> the standalone runtime image), and the default runtime for that shape is `bun` (the compiled bytecode executable) — the credentialed v1.0 default per ADR-0054/ADR-0058. If your `kn-next.config.ts` omits `build`, your next deploy will try to build and ship a completely different artifact.
  
  **If your app builds with vinext (its build script runs `vite build`), you MUST add `build: 'vinext'` to `kn-next.config.ts` before upgrading**, or `kn-next build`/`deploy` will look for a `.next/standalone` tree your build script never produces and fail:
  
  ```ts
  const config: KnativeNextConfig = {
    name: 'acme',
    registry: 'registry.example.com/acme',
    build: 'vinext',
  };
  ```
  
  Apps already on the standalone target (`build: 'turbopack'`/`'webpack'`, or building with `next build`) are unaffected by the `build` change. If you had `runtime` unset there too, it now defaults to `bun` (compiled bytecode) instead of `node` — set `runtime: 'node'` explicitly if you want the uncompiled fallback.
  
  Newly scaffolded apps pin `build: 'vinext'` explicitly (`kn-next create`'s templates), since their `next.config.ts` and `Dockerfile` are still vinext-shaped. A standalone-by-default scaffold is tracked as separate follow-up work.
- 8c238f3: The CLI command is now `knext` (was `kn-next`). `@getknext/core` ships both
  bins — `knext` is canonical, and `kn-next` keeps working as a deprecated
  alias: same dispatch, same flags, same exit codes, with one added line on
  stderr pointing at `knext`. Existing scripts and CI invoking `kn-next` are
  not broken by this release.
  
  `knext create` now scaffolds apps whose generated `package.json`, README-style
  comments, and printed "next steps" all say `knext`. The config file itself is
  unchanged — it is still named `kn-next.config.ts` (not renamed in this
  release).
  
  CLI help/usage text, error messages, and the docs site (getting-started, CLI
  reference, examples) were updated to say `knext` throughout, with a short note
  in the getting-started guide about the `kn-next` alias, plus a warning not to
  run bare `npx knext` on its own — the unscoped `knext` name on the public npm
  registry belongs to an unrelated package. Always use `npx @getknext/core ...`
  or a locally installed `knext`.
- 1363eb3: Add `knext init-ci --provider gitlab`, generating a `.gitlab-ci.yml` pipeline with the
  same credential preflight the GitHub Action already runs — a `preflight` stage
  (`kubeconfig-check`, `credential-preflight`) that must pass before `deploy` runs. Omitting
  `--provider` still defaults to `github` and writes byte-identical output to before this flag
  existed. `--push-secret` gains a GitLab path too: it classifies the kubeconfig first (refusing
  an exec-plugin credential before `glab` is ever invoked), then sets the masked/protected CI
  variable via `glab variable set` with the value passed on stdin only — never on the command
  line, in the environment, or in output. With no `glab` installed, it prints the manual steps for
  GitLab's UI instead of failing. A new `knext ci-preflight --namespace <ns>` verb runs the same
  checks the GitHub Action's preflight step runs, so any CI provider can invoke the identical
  hazard check without re-implementing it in shell.
- d0a1d2b: Self-contained mode (experimental) now does something on the compiled
  standalone-on-Bun target: with `selfContained: true` / `--self-contained`, the
  executable embeds the app's server build output, Next.js's server modules and
  the build manifests, and starts from a directory holding only itself,
  `public/` and `.next/static/`. Every embedded route chunk is verified to carry
  bytecode. With the flag off, the build is unchanged. If a dependency ships a
  native addon (a compiled `.node` file), the build now fails and names the
  file instead of silently embedding it as inert data.
- 936979f: Add an opt-in `selfContained` config key and a `knext build --self-contained`
  flag (default off). No build target acts on it yet, so the artifacts a build
  produces are byte-identical either way; the setting is validated as a boolean
  and recorded in the build log (the "Configuration loaded" line now always
  carries a `selfContained` field).
- 631b7b5: `knext build --self-contained` (or `selfContained: true`) now takes effect on the
  vinext target: the single executable embeds the server runtime, `.output/public`
  and sharp's native libraries, so it serves from a directory that holds nothing
  but the binary. The native libraries are unpacked into the temp directory the
  first time an image is optimized — boot and health checks never pay for it —
  so that directory must be writable (the knext operator mounts one at `/tmp`).
  Off by default; disk-mode builds are unchanged.

### Patch Changes

- 08661bd: `kn-next doctor` now checks whether a scaffolded `knext-node-entry.mjs` (used
  by `build: 'vinext'` + `runtime: 'node'` apps) is behind the version shipped
  in the installed `@getknext/core` package, and warns with the exact fix when
  it is stale — the entry is written once by `kn-next create` and never
  re-rendered by later builds or deploys, so an app scaffolded before a runtime
  fix keeps running the old behavior silently.
  
  The deployed Cache-Control normalization (both the `vinext`-on-Node middleware
  and the compiled executable's `Bun.serve` seam share one implementation) now
  falls back to rebuilding the `Response` when its headers are immutable — a
  proxied `fetch()` response or `Response.redirect()` — instead of silently
  skipping the rewrite and shipping the origin `s-maxage=…` value to clients.
- 40a7323: `kn-next status` now surfaces an `EnvMapCollision` row (human output) and an
  `envMapCollision` key (`--json` output) when a `spec.secrets.envMap` entry
  collides with a platform-managed system environment variable (e.g.
  `HOSTNAME`, `NODE_ENV`, or a conditionally-injected one like
  `STORAGE_PROVIDER`). The row/key mirror the operator's `EnvMapCollision`
  status condition: `True` while a collision exists (naming which side won),
  `False`/not reported otherwise. The documented connection-string pattern
  (binding `REDIS_URL`, `KAFKA_BROKER_URL`, or `OTEL_EXPORTER_OTLP_ENDPOINT`
  via `envMap`) renders calmly as informational rather than as an alarm.
- d727053: Harden request URL decoding in the scaffolded `vinext` server entries. A request
  whose path is not valid percent-encoding is now answered with `400 Bad Request`
  before routing, and any other failure on the request path becomes a plain `500`
  response instead of an error page or a process exit. The change lives in the
  scaffolded `runtime-contract.mjs`, `knext-bun-entry.mjs` and
  `knext-node-entry.mjs`; existing apps pick it up by copying those files from a
  fresh `kn-next create --builder vinext` (`kn-next doctor` flags a stale Node
  entry).
- 848f0ac: Bumped the scaffold's `next` pin to `16.3.5`, which fixes the confirmed
  upstream Turbopack + `adapterPath` + `output:'standalone'` regression
  (`ENOENT: .next/next-server.js.nft.json`) that affected stable Next 16.3.0
  through 16.3.4. `knext create` now scaffolds a plain
  `"build": "next build"` script again (Turbopack, the default builder) —
  the `--webpack` workaround pinned during the affected window is no longer
  needed and has been removed.
  
  The pre-build guard (`knext build`/`deploy`) that catches this regression
  for apps on an affected Next version is narrowed to fire only inside the
  confirmed window; apps on Next 16.3.5+ (or 16.2.x, which was never
  affected) are unblocked, with an "upgrade to next >= 16.3.5" fix suggestion.
  knext supports and tests against stable Next releases only — a
  canary/rc/preview/beta prerelease is not gated by this guard.
- 641c4e0: `kn-next deploy` no longer uploads static assets from a separate host build
  when your Dockerfile rebuilds in-image (vinext + object storage). The assets
  are now extracted from the image you are about to serve, and the deploy aborts
  if the image's server references a client chunk the extracted assets lack.
  Previously the two builds could produce different chunk hashes and the app's
  main chunk 404'd from the bucket.
- 68ea771: Three scaffold/CLI follow-ups from the #1368 review:
  
  - The turbopack pre-build guard (`checkTurbopackAdapterStandaloneRegression`)
    no longer falsely blocks an app whose `build` script delegates to other
    scripts (e.g. `"build": "run-s build:*"` with `--webpack` on a
    `"build:next"` script) — it now scans every script in `package.json`, not
    just `build`, for the escape-hatch flag, and the error message documents
    the delegation case.
  - The scaffolded `next.config.ts` (both the default and `--builder vinext`
    variants) no longer carries internal issue/PR/ADR references in its
    comments.
  - `kn-next build` on the default (standalone) target writes a compiled
    `knext-standalone-exec-<arch>` ship binary into the app root. It was not
    covered by any `knext-exec*` ignore pattern (a different, older binary
    name) — this repo's own root `.gitignore` and the scaffold's
    `.dockerignore.hbs` / `Dockerfile.vinext-node.dockerignore.hbs` now exclude
    it too.
- f068e36: `knext create` now scaffolds a `.gitignore` (both the default and `--builder vinext` variants). Previously scaffolded apps shipped none at all, so `node_modules`, `.next`, `.output`, compiled `knext-exec*`/`knext-standalone-exec*` binaries, and `.env` files were all committable by default — the `.env` case is a secret-leak risk. The template ships internally as `gitignore.hbs` (npm strips a file literally named `.gitignore` from a published tarball) and is renamed to `.gitignore` when an app is scaffolded.
- 0fe8934: Internal groundwork for a self-contained single executable: a module that
  embeds extra files into a compiled binary at their original relative paths and
  verifies they resolve from inside it. Nothing uses it yet; build output and
  behaviour are unchanged.
- 30ff477: The compiled Bun standalone build now reports how many computed
  `require`/`import` call sites its bundled server code contains. These specifiers
  resolve from disk at runtime, where the build's module-sharing scan cannot see
  them. Set `KNEXT_STANDALONE_COMPILE_VERBOSE=1` to list them. This is
  informational only and does not change the build output.
- 17ccfc2: The monorepo's own toolchain now runs `tsc` typechecking on TypeScript 7
  (the native compiler) for speed, while its `typescript` devDependency stays
  on 5.9.x — `tsup`'s declaration-file bundler needs the classic TypeScript
  compiler API, which TypeScript 7 does not yet expose.
  
  Scaffolded apps are unaffected: `knext create` still pins
  `typescript@^5.9.3` by default. TypeScript 7 works for a scaffolded app's
  own build and typecheck (verified: `next build` succeeds clean under it),
  but it ships no `tsserver.js`, so editor TypeScript support that relies on
  "use workspace version" (VS Code's default) breaks today — see the
  TypeScript version doc for the opt-in path and what it costs.
- 2e136d6: `kn-next build` (vinext target) now bundles packages that nitro's server chunks load at runtime with `createRequire(import.meta.url)`, not only the ones the entry loads, so a chunked server bundle no longer produces a binary that fails with `Cannot find module` once deployed. Set `KNEXT_COMPILE_STRICT_REQUIRES=1` to fail the build, instead of warning, when such a package cannot be resolved.
- 3c94226: `kn-next build` on the vinext target now prints the compile step's informational output (e.g. which server externals load from `.output/server/node_modules` vs. stay bundled — the lines `docs/build-pipeline.mdx` quotes verbatim) instead of silently discarding it. `WARNING:` lines were already visible (they print via `console.warn`, to stderr); the discarded lines were the ones the compile step prints via `console.log`, to stdout. Normal build output stays quiet; only lines starting with `[knext compile]` are surfaced.
- 298de3c: vinext on Node (`runtime: 'node'` with the default build) now sends `public, max-age=0, must-revalidate` in place of Next.js's shared-cache directives, the same as the compiled executable and the standalone server. The scaffolded `knext-node-entry.mjs` turns on vinext's own deploy mode (`VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1`) and rewrites `s-maxage` headers your own code sets. Set `KNEXT_CACHE_CONTROL_NORMALIZE=0` to keep the original headers. An app created before this change has an older `knext-node-entry.mjs`; replace it with the one from a freshly created app to pick this up.
- fa9e55a: Image optimization for the vinext × node target (`runtime: 'node'`, not the default single
  executable) now actually resizes images instead of silently serving originals. Two fixes,
  both needed: `kn-next build` restages sharp's package and its platform addon into the image's
  build output on every build — nitro's own trace previously copied an incomplete package and the
  build host's addon rather than the image's `linuxmusl-x64` one — and the scaffolded
  `knext-node-entry.mjs` now passes sharp directly to knext's image optimizer, the same way the Bun
  single-executable entry already does, instead of a runtime resolve that can never find
  `.output/server/node_modules` from the image's working directory. An app scaffolded before this
  behaviour existed has an older `knext-node-entry.mjs` — rebuilding is not enough on its own, since
  that file's old resolve strategy keeps serving originals regardless; replace it with the one from
  a freshly created app to pick this up.
- 8326926: The scaffolded `vinext` server entries now warm `KNEXT_WARM_PATH` inside the
  same execution context as live requests. Work a warm route schedules with
  `after()` is therefore awaited by the image's compile-cache bake and by the
  SIGTERM drain, instead of being cut off when the process exits.
- 3650f50: `knext build`/`deploy` now set their own `KNEXT_BUILD_ID` environment variable (the
  deploy tag) instead of relying on `NEXT_DEPLOYMENT_ID`. On Next.js 16.2.11 and later, Next
  ignores a configured `generateBuildId` whenever it sees a deployment id and writes its own fixed
  build id instead, which silently breaks skew protection's build-id contract. The scaffolded
  `next.config.ts` now reads the new variable first and falls back to the old one:

  ```ts
  generateBuildId: () => process.env.KNEXT_BUILD_ID || process.env.NEXT_DEPLOYMENT_ID || null,
  ```

  **Migration for apps scaffolded before this release:** update `generateBuildId` in your
  `next.config` to the line above. On an affected Next version, `knext build`/`deploy` now print a
  clear error naming this exact fix when they detect an app still on the old `generateBuildId` (or
  none at all).
- e18d16e: The GitHub Action (`getknext-dev/knext-action`) now installs Bun before deploying.
  Previously it never installed Bun at all, so every deploy using the default runtime (which
  compiles the standalone server with a bare `bun` binary) failed with a "command not found" error
  on stock GitHub-hosted runners, which ship no Bun by default. No workflow changes are needed on
  your side — the fix is entirely inside the action.
- 8340de9: Raised the shipped compile-cache bake driver's cold-boot deadline from 30s to 60s
  before it gives up and fails the build. A real, if less common, app shape (routes with
  Proxy/middleware-driven dynamic redirects or rewrites) can take longer than 30s to answer its
  very first, fully-cold request — which is exactly the request the bake driver waits on. A normal
  boot pays nothing extra; a genuinely hung server still fails the build, just up to 30s later than
  before. The driver also now logs how long the boot actually took, so a build that is getting
  close to the ceiling is visible in your build logs instead of only showing up as a failure.
- @getknext/db@1.0.0-rc.1
  - @getknext/lib@1.0.0-rc.1

## 0.4.3

### Patch Changes

- 445059f: The Bun executable now runs `after()` work before it exits on `SIGTERM`. The scaffolded `knext-bun-entry.mjs` did not give vinext's `after()` an execution context, so its callbacks were fire-and-forget: a scale-down right after a response logged a clean drain and exited 0 with the callback never run. Each request now runs inside the runtime contract's context, and the shutdown drain waits for that work. The drain in `runtime-contract.mjs` (shared with the Node server entry) also keeps waiting while in-flight work schedules more, so an `after()` callback that calls `after(promise)` during shutdown is no longer cut off. Existing apps pick this up by copying `knext-bun-entry.mjs` and `runtime-contract.mjs` from a freshly created app.
- 6a94212: The compiled Bun single executable now works for apps that depend on `@opentelemetry/*` packages. vinext keeps those packages external to the server bundle, which loads them at runtime from `.output/server/node_modules`. The compiled executable has no such directory next to it, so every request failed with `Cannot find module '@opentelemetry/api'`. `kn-next build` now bundles every package the server entry loads that way into the executable. A package that cannot be resolved at build time is left as a runtime load, and the build prints a warning naming it.
- ff1c6a8: The compiled Bun single executable now loads your server's CommonJS external packages (those in `serverExternalPackages` and Next.js's default external list) from `.output/server/node_modules` when that directory is deployed next to the executable, and a runtime `require.resolve()` finds packages there too. When the directory is absent, the copy bundled into the executable is used. Packages that need their own files at runtime, such as `typescript` or native addons such as `sqlite3`, used to fail inside the executable with `Cannot find module` or `Could not find module root`. The executable loads these packages only from that directory. `kn-next build` names the packages it loads from the directory, and warns when one ships a native addon.
- e7f33dc: Security: the standalone runtime image no longer includes the app's `.env*` files or other secret files (`*.pem`, `*.key`, `*.p12`, `.npmrc`, `.netrc`, `kubeconfig`, `.kube/`; `.env.example` is still kept) copied by `next build` into `.next/standalone/`. Previously the generated ignore rules only excluded these at the build-context root.
  
  If you built images with the standalone target and kept secrets in `.env*` files, rebuild your images with this release and rotate those secrets. Supply secrets through `env` / `secrets` in `kn-next.config.ts` (Kubernetes Secrets) instead of `.env*` files.
- deaaa5a: `healthCheckPath` in `kn-next.config.ts` is now validated: it must start with a leading slash and must not contain a comma or whitespace. This value is joined into a comma-separated list of warm-up paths at image-build time, so a missing slash or an embedded comma or space used to corrupt that list silently instead of failing at `kn-next deploy`/`preview`/`build` time.
- 15dcdc1: New apps scaffolded by `kn-next` now pin vinext `1.0.0-beta.12` (was `1.0.0-beta.11`). The peer ranges vinext declares are unchanged, so existing apps need no other change to upgrade.
- 3a84e65: The compiled Bun executable now sends `public, max-age=0, must-revalidate` in place of Next.js's shared-cache directives (`s-maxage=…, stale-while-revalidate=…`), matching knext's standalone server and what a deployed Next.js app returns to browsers. It turns on vinext's own deploy mode (`VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1`) for the responses vinext builds, including the first request for a `fallback: true` page, and rewrites `s-maxage` headers your own code sets. Set `KNEXT_CACHE_CONTROL_NORMALIZE=0` to keep the original headers, for example when your own CDN sits in front of the app; that also leaves vinext's deploy mode off.
- @getknext/db@0.4.3
  - @getknext/lib@0.4.3

## 0.4.2

### Patch Changes

- 210a2b7: Scaffolded apps now `npm install` cleanly on npm 10.x. The app template pinned `vitest@^4`, whose Vite peer range excludes the `vite@8` the template also pins; on npm 10 that unsatisfiable peer aborts the install with an internal `edgesOut` error instead of a clean message. The template now pins `vitest@^5`, which supports Vite 8. (The template source was already corrected; this releases it so the published CLI scaffolds an installable app.)
- @getknext/db@0.4.2
  - @getknext/lib@0.4.2

## 0.4.1

### Patch Changes

- Republish the @getknext/* group at 0.4.1. The 0.4.0 tarballs shipped unresolvable `workspace:` ranges in their sibling dependencies (EUNSUPPORTEDPROTOCOL on install), so `@latest` was rolled back to 0.3.1. The release lane now rewrites `workspace:` ranges to the concrete published version at publish time and a guard verifies the packed tarballs before publishing (see docs/incidents/2026-09-08-npm-release-workspace-and-partial-publish.md). This patch re-ships the 0.4.0 content — the create verb, the OTel fix, and the rest — as an installable 0.4.1.
- Updated dependencies
  - @getknext/lib@0.4.1
  - @getknext/db@0.4.1

## 0.4.0

### Minor Changes

- a450c9f: BREAKING (default metrics port): the app metrics port default moves from 9091
  to 9464 (#951). Anything OUTSIDE knext that scrapes the old port goes dark on
  upgrade — hand-rolled Prometheus scrape configs, ServiceMonitors/PodMonitors
  you wrote yourself, Grafana datasource queries pinned to `:9091`, and
  NetworkPolicies you added alongside knext's must all be repointed to `:9464`
  (knext's own annotation, NetworkPolicy, PodMonitor and dashboards move
  automatically). See the "Upgrading" docs page for the ordered steps and the
  verification command.
  
  Why: on a stock Knative
  Serving install (default `config-observability`), the queue-proxy sidecar binds
  `:9091` in every revision pod for its own user-metrics server, so an app
  defaulting to 9091 lost the port race and crash-looped with `EADDRINUSE`. The
  runtime entries' `METRICS_PORT` default, the operator's `prometheus.io/port`
  annotation, the default NetworkPolicy's metrics-scrape grants and the shipped
  PodMonitor all move to 9464 together (locksteped by
  `metrics-port-lockstep.test.ts`), and `kn-next doctor` now detects the
  collision condition (queue-proxy user metrics active + an app pinned onto
  `METRICS_PORT=9091`) and says how to resolve it. Upgrade order matters as
  always (#548): operator/CRD first, then CLI — a new runtime image scraped by an
  old operator (or vice versa) scrapes the wrong port until both sides are on the
  same release.

### Patch Changes

- @getknext/db@0.4.0
  - @getknext/lib@0.4.0

## 0.3.1

### Patch Changes

- bf03457: Version the three published packages in lockstep.
  
  `@getknext/core` depends on `@getknext/lib` and `@getknext/db`, so the three have always had to
  ship as a set — but that was a documented intention, and the tree had already drifted to three
  different numbers. They are now a Changesets `fixed` group, so every release moves all three to the
  same version, and a guard fails if they diverge or if a fourth publishable package appears.
  
  No API change. From this release on, pinning `@getknext/core@x.y.z` pins the whole set.
- 588d1ef: The operator's default NetworkPolicy now restricts ingress **ports**, and scopes same-namespace
  access to metrics only.
  
  Previously the policy allowed any admitted source to reach **any port** on your app's pods. In
  practice that meant a pod sharing your namespace could dial your app container directly, bypassing
  the Knative queue-proxy — and with it your app's concurrency limit and one layer of HTTP parsing.
  
  The policy now admits the queue-proxy ports (`8012`/`8013`, and `8112` for Knative's internal
  TLS path) and the metrics ports (`9090`, `9091`)
  from `knative-serving`/`kourier-system`, and the **metrics ports only** from same-namespace pods.
  Your app's container port is deliberately excluded — the queue-proxy reaches it over pod-local
  loopback, which no NetworkPolicy governs.
  
  **Behaviour change.** If something in your namespace called your app directly on its container
  port, that call now fails. Call the app through its service URL instead (gateway-routed, still
  allowed), or opt out with `spec.security.networkPolicy: false`.
  
  **Enforcement depends on your CNI.** Calico and Cilium enforce NetworkPolicy; flannel ships no
  policy controller, so on a flannel cluster this object is declarative only and changes nothing.
- Updated dependencies [bf03457]
  - @getknext/lib@0.3.1
  - @getknext/db@0.3.1

## 0.3.0

### Minor Changes

- 6e9c713: Add a public `@getknext/core/validate` subpath.

  `validateConfig` (and its `ConfigValidationError` result type) are now a
  supported public import. Use them as a config-quality gate in your own CI to
  validate a `kn-next.config.ts` against the exact rules the deploy step applies,
  before a bad config reaches the cluster:

  ```ts
  import {
    validateConfig,
    ConfigValidationError,
  } from "@getknext/core/validate";
  ```

  The module is pure — importing it runs no I/O and never exits the process — so
  it is safe to pull into your own build/test process. The previous
  `@getknext/core/internal/cli-validate` subpath remains for internal CLI wiring but
  carries no stability guarantee; prefer the public `@getknext/core/validate`.

### Patch Changes

- Updated dependencies [2c156a7]
  - @getknext/db@0.2.1

## 0.2.0

### Minor Changes

- e6288df: feat(db): `kn-next db migrate` one-shot migration runner + Job recipe (ADR-0021 §3)

  Completes the `@getknext/db/migrate` surface with the writer-only migration runner.

  - **`@getknext/db/migrate` → `runMigrations(options?, deps?)`** applies
    drizzle-kit-generated migrations against the **writer** (`DATABASE_URL`) via
    drizzle-orm's node-postgres migrator, then exits. It resolves + guards the DSN
    (`resolveWriterDsn`): it **refuses** a read-replica DSN — an exact
    `DATABASE_URL_RO`, or any DSN on the RO gateway port `55434` — because
    single-writer forbids writes on the replica. Idempotent (drizzle tracks applied
    migrations) and **fail loud** (rejects on error; the connection is always
    closed). `pg` is now a runtime dependency of `@getknext/db`.
  - **`kn-next db migrate`** wraps it as a CLI subcommand — run it once per deploy
    (a CI step or a pre-deploy k8s Job), out of the request path, never on pod boot
    and never operator-run. A failure exits non-zero so a Job fails loudly.
  - **Docs:** the `@getknext/db` README gains a migrations section, the "running
    migrations for a NextApp" flow, and a one-shot **Job recipe** (writer-only,
    `restartPolicy: Never`, sequenced after the `AppDatabase` is `Ready`).

### Patch Changes

- Re-release the full three-package set: `@getknext/db` joins the published packages
  (`@getknext/core` depends on it for `kn-next db migrate`), so all three bump
  together and ship as a set — publishing core without db breaks every consumer
  install with a 404 on the missing member.
- Updated dependencies [9810a00]
- Updated dependencies [dd20ad2]
- Updated dependencies [e6288df]
- Updated dependencies [49a48e4]
- Updated dependencies [82ddbef]
- Updated dependencies
  - @getknext/db@0.2.0
  - @getknext/lib@0.2.0
