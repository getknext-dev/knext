# @getknext/core

## 0.5.0

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
- @getknext/db@0.5.0
  - @getknext/lib@0.5.0

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
