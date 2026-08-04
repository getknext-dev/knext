# ADR-0041 — `kn-next create` scaffolds the guarded instrumentation (amends ADR-0031)

- **Status:** Accepted
- **Date:** 2026-08-04
- **Issue:** #407 (deferred option from #356 / PR #406, ADR-0031 options table).
- **Amends:** ADR-0031 — promotes its last, deferred option ("CLI `kn-next
  create` scaffolding command") from *Deferred* to *Accepted*. Everything else
  in ADR-0031 stands unchanged, including its #408 amendment (the edge fence
  applies in every phase).
- **Upholds:** ADR-0027 (`globalThis`-anchored seams, `@getknext/lib` stays
  bundled), ADR-0012 (OTel default-off), ADR-0001 (this command performs **no**
  cluster writes).

## Context

ADR-0031 made the in-repo `turbo gen zone` template emit guarded instrumentation
by default, and recorded a CLI `create` flow as *deferred* — "the template is
the existing scaffolding path; a CLI create flow can adopt the same emitted
shape later".

That deferral left a real hole, and the wayfinder failure surface names it
(C6): the zone template is reachable only from inside this monorepo. Every app
created **outside** it — the audience `@getknext/core` is published for — starts
from `docs/QUICKSTART.md` and hand-writes the #342 edge fence, which is exactly
the footgun ADR-0031 removed for generated apps. Hand-writing it is not a
theoretical risk: the fence's load-bearing half is a webpack `IgnorePlugin` on
the edge compile, and omitting it fails the production build (noisy) while
omitting the seam wiring kills observability (silent, #352).

The second-emitter problem is the reason this was deferred rather than obvious:
two copies of a ~200-line safety guard drift, and the copy that drifts
unnoticed is the published one, because nobody in this repo builds it.

## Decision

1. **`kn-next create [dir]` scaffolds an app carrying the same guarded
   instrumentation the zone template emits** — `src/instrumentation.ts` (edge
   clean, `NEXT_RUNTIME` guard, static-literal dynamic import),
   `src/instrumentation-node.ts` (the platform wiring behind
   `resolveOtelOptions`), `next-adapter.ts` + `adapterPath` (the fence carrier),
   and BOTH per-app guards (`instrumentation-edge-safe.test.ts`,
   `standalone-seam-alive.test.ts`) plus the `test:seam` script that runs the
   latter for real (build + `KNEXT_REQUIRE_STANDALONE=1`), so it can never be
   green-by-skip (#408).

2. **The templates ship in the package** (`packages/kn-next/templates/app`,
   added to the `files` allowlist) as `.hbs` files, so this repo's own
   vitest/biome/tsc never collect them as sources.

3. **The two template trees' SHAPE files are pinned against drift, not trusted**
   (`create-scaffold-parity.test.ts`). Every file in
   `turbo/generators/templates/zone/` must be classified as:
   - **VERBATIM** — byte-identical in both trees (`next-adapter.ts`,
     `instrumentation-edge-safe.test.ts`, `src/instrumentation.ts`,
     `src/instrumentation-node.ts`);
   - **NORMALIZED** — identical once placeholder-bearing lines are dropped
     (`standalone-seam-alive.test.ts`: only the standalone path and the run
     instructions differ); or
   - **LAYOUT** — genuinely different, WITH the reason recorded (the zone
     `package.json` uses `workspace:*` and the private `@getknext/ui`; the zone
     `next.config.ts` sets a multi-zone `basePath`).

   The classification is an allowlist and **fails closed**: a new zone template
   file reddens the guard until someone classifies it.

   **What this does NOT pin — say it plainly.** The guard covers the VERBATIM
   and NORMALIZED buckets, i.e. the *shape*: the instrumentation pair, the
   adapter wiring, and the two guards. Files in the **LAYOUT** bucket are
   compared on nothing at all — being in that bucket means "allowed to differ",
   and the guard cannot tell an intended difference from an accidental one.
   Dependency VERSIONS live there, in `package.json.hbs`.

   That is not hypothetical, and the counterexample is in the tree at the time
   of writing: `turbo/generators/templates/zone/package.json.hbs:16` pins
   `next: 16.2.10` while the workspace and the CLI template are on `16.2.11`
   (#579 bumped the workspace, not the zone template). Live drift, in the exact
   bucket this guard exempts — so `turbo gen zone` currently scaffolds an app
   onto a Next version the compat suite is no longer verifying. A guard
   asserting both trees' `next` pin equals the workspace's compat-verified
   version is the fix, and is tracked separately; until it lands, "pinned
   against drift" must be read as *shape only*.

4. **The emitted standalone path is derived from the app's layout**, not
   assumed. Next infers `outputFileTracingRoot` from the nearest lockfile and
   nests `.next/standalone/<app-path-relative-to-it>/`. `standalonePrefixFor()`
   mirrors that, and the seam guard, the `start` script and the `Dockerfile`
   all consume the one inference — a guard pointed at the wrong directory finds
   no build and **skips**, which is the decoration #408 removed.

5. **No cluster writes.** `create` only writes files, and refuses to overwrite
   an existing one (aborting before touching anything) unless `--force`.

6. **The app name is VALIDATED as an RFC1123 label, and rejected — never
   escaped.** It is interpolated into JSON (`package.json`), TypeScript
   (`kn-next.config.ts`) and JSX (the page), *and* it becomes the NextApp /
   Knative Service name. Measured against the shipped bin before the fix:
   `--name 'ev"il'` **exited 0** and wrote a `package.json` that is not valid
   JSON. Escaping would only move the failure later — `My App` escapes fine and
   is still a Service name Kubernetes refuses — so the scaffolder refuses up
   front, the same discipline `renderScaffold` already applies to an
   unsubstituted placeholder. The name defaults to the directory basename, so
   this path is reachable with no flag at all.

7. **The generated `Dockerfile` builds from the TRACING ROOT, and boots the
   knext runtime entry.** Three decisions, each of which was wrong in the first
   round:
   - **Build context = the inferred tracing root** (the outermost lockfile
     ancestor), stated in the emitted file rather than assumed. The install runs
     at that root — where the lockfile actually is, since none of `npm ci` /
     `pnpm install` / `yarn install` walk up — and the *build* runs in the app
     directory. In a workspace those are different places; conflating them made
     the emitted Dockerfile unbuildable in both common layouts.
   - **The install command matches the lockfile that was found** (`npm ci` vs
     `pnpm install --frozen-lockfile` vs `yarn install --immutable`); `npm ci`
     cannot consume a `pnpm-lock.yaml`.
   - **`CMD` boots `@getknext/core/internal/node-server`, not a bare
     `node server.js`.** That entry is the only thing installing the SIGTERM
     handler which drains in-flight requests and runs `after()` callbacks
     (`security.md`, graceful shutdown). A bare exec bypasses it, so every
     created app would have shipped without that invariant. The base image is
     digest-pinned and the runtime drops to the non-root `node` user, per the
     same rules file.

## Options considered

| Approach | Single shape | Drift-proof | Works outside the monorepo | Verdict |
| --- | --- | --- | --- | --- |
| Ship templates in `@getknext/core` + byte-parity guard against the zone tree | yes | **enforced for the shape** (allowlist, fails closed); **NOT** for the LAYOUT bucket, where dependency versions live — see §3 | yes | **Accepted** |
| Point the turbo generator at the package templates (one physical tree) | yes | trivially | yes | Rejected *for now* — strictly better on paper, but it moves the `pnpm generate` inputs and the zone-specific files (`workspace:*` deps, `basePath`) still cannot be shared, so it buys less than it risks in this issue's blast radius. Worth revisiting if the LAYOUT bucket ever empties. |
| Embed the templates as TS string constants in the bundle | yes | same guard possible | yes | Rejected — 400 lines of guard source inside a shipped module, and diffs become unreadable |
| Docs-only ("copy these files") | no | no | yes | Rejected — that is today's state; it is what #407 exists to fix |

## Consequences

- An app created with `kn-next create` is covered by the #408 per-app seam
  matrix *by construction*: scaffolded into `apps/<name>` it appears in BOTH
  `appsRequiringSeamGuard()` and `discoverSeamAliveApps()`, so it can never open
  a coverage hole (asserted in `create-scaffold.test.ts`).
- Editing the guarded-instrumentation shape now means editing it **twice** —
  deliberately, with a red test until both trees agree. Editing a LAYOUT-bucket
  file (a dependency bump, notably `next`) means editing it twice **with nothing
  telling you**, which is how the two trees are already out of step (§3).
- The generated `package.json` pins `@getknext/core` / `@getknext/lib` to the
  CLI's own version. Until the packages are published to npm, `npm install` in a
  generated app cannot resolve them — the scaffold is correct but not yet
  installable, blocked on the same npm-publish step as `npx kn-next`.
- `kn-next create` is a new **public CLI surface** (a workflow escalation
  trigger). It is deliberately minimal — no framework choices, no cluster
  contact, no interactive prompts — so the surface it adds is one verb and three
  flags.
- **Known divergence, tracked separately:** `kn-next deploy` hardcodes the docker
  build context as two directories above the app (`resolve(cwd, "../..")`),
  which assumes an `apps/<name>` layout, while `create` derives the context from
  the nearest lockfile. The two AGREE for `apps/<name>` — the layout QUICKSTART
  prescribes — and DISAGREE for a flat single-app repo, which `create` now makes
  an ordinary case. The generated Dockerfile therefore states its required
  context explicitly rather than relying on the caller's default.
- The base-image pin guard (`scripts/check-base-images-pinned.sh`) now **scans**
  for Dockerfiles instead of enumerating two of them — the template Dockerfile
  was invisible to it purely by omission. The scan surfaced four pre-existing
  unpinned Dockerfiles; they are listed as tracked exceptions that are REPORTED
  on every run (and the summary line refuses to claim "all pinned" while any
  remain), so they cannot quietly become permanent. Anything not on that list
  and not pinned fails: the scan fails closed.
