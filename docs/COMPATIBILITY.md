# knext compatibility matrix — operator ↔ CLI ↔ packages

> Internal maintainer doc (it may reference issues and workflow internals). The policy that governs
> it — cadence, what a version promises, support window, deprecation — is
> [`docs/RELEASE_POLICY.md`](RELEASE_POLICY.md). The user-facing version of this page is the docs
> site's *Versioning & compatibility*.
>
> **Who updates it, and when:** the maintainer cutting the release, **on `main`, before the
> "version packages" PR merges.** `tests/release-policy-matrix.test.ts` asserts the matrix carries a
> row for the version in the tree, so the release PR is red until the row exists — but the guard
> only checks that a row is *there*, not where it was added, and **where matters:**
>
> Do **not** hand-edit the row into the `changeset-release/main` PR. `changesets/action` recreates
> that branch and **force-pushes** it on every subsequent push to `main`, so a row added there is
> silently discarded the moment anything else merges first — and the loss looks like a flaky guard
> rather than a lost commit. The durable path is to add the next row to this file on `main` ahead of
> the release; the version is predictable (`changeset status --output` prints the exact
> `newVersion`), so the row can always be written before the bump lands.

## The three axes

knext ships three things that version on **separate** lines. Nothing forces them to move together:

| Thing | Ships as | Version line |
| --- | --- | --- |
| `@getknext/core`, `@getknext/lib`, `@getknext/db` | npm packages | semver, **one shared number** across the three |
| the operator | a container image + an `install.yaml` bundle | **no semver line today** — see below |
| the `NextApp` CRD | inside the operator bundle | the Kubernetes ladder: `v1alpha1` → `v1beta1` → `v1` |

## The matrix

| Package set | CRD `apiVersion` | Operator bundle | Notes |
| --- | --- | --- | --- |
| `1.3.0-rc.5` (in tree, npm dist-tag `next`) | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate on a separate line; does **not** replace `1.0.0-rc.5` (`rc` stays on rc.5, `latest` unchanged). Six fixes on rc.4: `knext build` stages the image build context so the image can be built on Cloud Build or CI; `knext deploy --image` no longer trips on the scaffold's placeholder `registry`; `KN_REDIS_URL` alone satisfies `knext deploy` and `knext preview`; the operator warns (a `PrivateExposure` condition and an event) when a `DomainMapping` publishes a private app; `next/og` (`ImageResponse`) works on the vinext target on Bun and Node; and the CRD preflight refusal lists only fields present in the applied CR. **No new CRD field**; the rc.3 constraint stands: **no published operator release supports `spec.networking.visibility` or rc.2's `spec.security.writeFree` yet** (`operator-latest` is built from the v1.0 line), so private apps, vinext apps, and standalone apps with `storage` or a self-contained executable fail the deploy preflight when `knext deploy` builds the image, until one is. The `PrivateExposure` warning needs an operator built from this line, so it does not appear on the published operator images (see `docs/release/v1.3.0-rc.5.md`). **No new credentialed combinations:** the v1.0 credential for the four Node/Bun x Turbopack/Webpack combinations is still in progress on rc.5, and vinext is not credentialed. Same CRD `apiVersion` (`v1alpha1`) as `1.0.0-rc.5`. Upgrade operator/CRD first, then CLI. |
| `1.3.0-rc.4` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate on a separate line; does **not** replace `1.0.0-rc.5` (`rc` stays on rc.5, `latest` unchanged). Three fixes on rc.3: a private preview can be made public by setting `networking.visibility: "public"` in config; `knext build` no longer requires `REDIS_URL` for a Redis-cache app (it is required at `knext deploy`); and ISR pages generated at request time are a cache hit, not stale, on the first request after a wake (Redis cache handler). **No new CRD field**; the rc.3 constraint stands: **no published operator release supports `spec.networking.visibility` or rc.2's `spec.security.writeFree` yet** (`operator-latest` is built from the v1.0 line), so private apps, vinext apps, and standalone apps with `storage` or a self-contained executable fail the deploy preflight when `knext deploy` builds the image, until one is (see `docs/release/v1.3.0-rc.4.md`). **No new credentialed combinations:** the v1.0 credential for the four Node/Bun x Turbopack/Webpack combinations is still in progress on rc.5, and vinext is not credentialed. Same CRD `apiVersion` (`v1alpha1`) as `1.0.0-rc.5`. Upgrade operator/CRD first, then CLI. |
| `1.3.0-rc.3` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate on a separate line; does **not** replace `1.0.0-rc.5` (`rc` stays on rc.5, `latest` unchanged). Adds private apps (`networking.visibility` in `knext.config.ts`, `knext deploy --private`/`--public`, with a guard against silently making a private app public); `knext deploy --image` no longer requires a lockfile. vinext target: fixes the image build after a plain `npm install` on the Node runtime, the ~10 s cold starts seen on some clusters, `next/og` in the compiled executable, and a server action `redirect()` status; new vinext scaffolds pin `@vercel/og` to `0.11.1` and install again after `@vitejs/plugin-react` 6.1.2 broke them. Adds one new, additive, optional CRD field (`spec.networking.visibility`); **no published operator release supports it or rc.2's `spec.security.writeFree` yet** (`operator-latest` is built from the v1.0 line), so private apps, vinext apps, and standalone apps with `storage` or a self-contained executable fail the deploy preflight when `knext deploy` builds the image, until one is. **Known issue:** a Knative `DomainMapping` pointing at a private app routes it publicly; do not add one (see `docs/release/v1.3.0-rc.3.md`). **No new credentialed combinations:** the v1.0 credential for the four Node/Bun x Turbopack/Webpack combinations is still in progress on rc.5, and vinext is not credentialed. Same CRD `apiVersion` (`v1alpha1`) as `1.0.0-rc.5`. Upgrade operator/CRD first, then CLI. |
| `1.3.0-rc.2` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate on a separate line; does **not** replace `1.0.0-rc.5` (`rc` stays on rc.5, `latest` unchanged). Drops the default scratch volume for apps with object storage configured and for disk-mode vinext apps (optimized images route through the cache handler instead); fixes the Node runtime's ISR/data cache silently falling back to memory when Redis is configured; `knext create` gains interactive prompts (runtime, builder, cache, storage, React Compiler — on by default for new apps); new scaffolds drop `containerConcurrency: 100`; five more small vinext fixes (including `next/image` honouring `trailingSlash` and a custom `loader`'s responsive `srcSet`). Adds one new, additive, optional CRD field (`spec.security.writeFree`). **Unlike rc.1, this release's fixes DO reach default-target (Turbopack/Webpack) apps** (see `docs/release/v1.3.0-rc.2.md`). **No new credentialed combinations:** the v1.0 credential for the four Node/Bun x Turbopack/Webpack combinations is still in progress on rc.5, and vinext is not credentialed. Same CRD `apiVersion` (`v1alpha1`) as `1.0.0-rc.5`; no published operator release supports `spec.security.writeFree` yet (see `docs/release/v1.3.0-rc.3.md`). Upgrade operator/CRD first, then CLI. |
| `1.3.0-rc.1` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate on a separate line; does **not** replace `1.0.0-rc.5` (`rc` stays on rc.5, `latest` unchanged). Adds to the opt-in, Beta vinext build target: vinext pinned to stable `1.0.1`, six bundled vinext fixes applied by the new `knext vinext-patches` verb, the glibc `sharp` build-check fix, and two experimental compile options (`compile.include`, and an opt-in sha256-pinned patched Bun toolchain for the compile step). Docs URLs move to knext-platform.dev. **No new credentialed combinations:** the v1.0 credential for the four Node/Bun x Turbopack/Webpack combinations is still in progress on rc.5, and vinext is not credentialed (see `docs/release/v1.3.0-rc.1.md`). Same CRD (`v1alpha1`) and operator bundle as `1.0.0-rc.5`. Upgrade operator/CRD first, then CLI. |
| `1.0.0-rc.5` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate, not the final v1.0 — cold-start fixes: skips the tracing-client import at startup when tracing is off (~0.8-0.9s), fixes a stale network-neighbour entry on some clusters that stalled a wake's first request (~10.2s -> ~2.4s on the affected node, no overhead elsewhere; opt out with `KNEXT_ARP_PRIMER=0`), loads the Cerbos/MinIO SDK clients lazily on first use (~0.5s), and drops the default scratch (`emptyDir`) volume for apps with no object storage configured (~0.36s). **Upgrade note:** apps that write to `os.tmpdir()` or similar at runtime need `spec.security.writableCache: true` set *before* upgrading (apps with `spec.storage`, or single-executable builds, keep their writable path automatically). Adds one new, additive, optional CRD field (`spec.security.writableCache`); same CRD `apiVersion` (`v1alpha1`) as `1.0.0-rc.4`, operator bundle content changes. The 14-consecutive-nightly-green windows restart on rc.5 for all four Node/Bun x Turbopack/Webpack combinations, still credentialed against `16.3.6` (see `docs/release/v1.0.0-rc.5.md`). Upgrade operator/CRD first, then CLI. |
| `1.0.0-rc.4` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate, not the final v1.0 — security: new scaffolds pin Next.js `16.3.6` (fixes GHSA-vcvr-r3jv-pc5j, a critical `next/og` `ImageResponse` RCE affecting next `>=16.2.0 <16.3.6`; existing apps should run `npm install next@16.3.6`); also fixes on-demand invalidation (`revalidateTag`/`revalidatePath`) so it actually evicts statically and ISR-cached pages with the Redis cache handler, not just fetch-cache entries. The 14-consecutive-nightly-green windows restart on rc.4 for all four Node/Bun x Turbopack/Webpack combinations, now credentialed against `16.3.6` (see `docs/release/v1.0.0-rc.4.md`). **Non-breaking**; same CRD (`v1alpha1`) and operator bundle as `1.0.0-rc.3`. Upgrade operator/CRD first, then CLI. |
| `1.0.0-rc.3` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate, not the final v1.0 — a re-cut of `1.0.0-rc.2` with **no package code changes**: the published tarballs differ from rc.2 only in version fields. It exists so the compat credential runs against a release tag whose test harness covers the `sharp` version Next.js `16.3.5` ships (the Bun credential runs could not execute against rc.2). The 14-consecutive-nightly-green windows restart on rc.3 for all four Node/Bun x Turbopack/Webpack combinations, still credentialed against `16.3.5` (see `docs/release/v1.0.0-rc.3.md`). **Non-breaking**; same CRD (`v1alpha1`) and operator bundle as `1.0.0-rc.2`. Upgrade operator/CRD first, then CLI. |
| `1.0.0-rc.2` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate, not the final v1.0 — renames the config file to `knext.config.ts` (**minor**, no dual-read — the pre-rename filename now fails fast with an actionable error, and `doctor` flags it; see `docs/release/v1.0.0-rc.2.md` for the migration note). Caps request bodies in-process on the standalone build too, on every route (**minor, behaviour change**: `413` above 8 MiB by default, raise or disable with `KNEXT_MAX_REQUEST_BYTES`; see the hardening guide). Marks `selfContained`/`knext build --self-contained` and the `preview`/`loadtest` CLI entries as experimental (outside the 1.0 semver commitment) and documents exit codes for every CLI verb — both non-breaking. Makes the standalone-node compile-cache bake robust to apps whose warm path redirects or is rewritten (no behaviour change to the shipped app; build-reliability fix). Rewrites the package READMEs for the npm listing. Moves the compat credential window from `16.2.12` to `16.3.5` (the scaffold's shipped pin), backed by a real per-entry re-audit of the pre-existing quarantine ledger against the new ref (see `docs/release/v1.0.0-rc.2.md` and `docs/compat-matrix.md`) — this half of rc.2 ships as its own PR, merged before this version bump. **Non-breaking otherwise**; same CRD (`v1alpha1`) and operator bundle as `1.0.0-rc.1`. Upgrade operator/CRD first, then CLI. |
| `1.0.0-rc.1` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | release candidate, not the final v1.0 — opens the 14-consecutive-nightly-green rehearsal window (see `docs/release/v1.0.0-rc.1.md`) for Node/Bun x Turbopack/Webpack, credentialed against Next.js `16.2.12`. **Non-breaking**; same CRD (`v1alpha1`) and operator bundle as `0.4.3`. Upgrade operator/CRD first, then CLI. |
| `0.4.3` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | patch. Security: the standalone runtime image no longer includes the app's `.env*` files or other secret files copied by `next build` into `.next/standalone/`. Pins vinext `1.0.0-beta.12`. Fixes the compiled Bun executable for apps with `@opentelemetry/*` dependencies and for CommonJS externals loaded from `.next/standalone/node_modules` at runtime, matches the executable's cache-control headers to the standalone server's, and runs `after()` work before the Bun executable exits on `SIGTERM`. `healthCheckPath` in `knext.config.ts` is now validated (leading slash, no comma or whitespace). **Non-breaking**; same CRD (`v1alpha1`) and operator bundle as `0.4.2`. Upgrade operator/CRD first, then CLI. |
| `0.4.2` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | patch. Fixes the scaffolded-app `npm install` crash on npm 10.x: the app template pinned `vitest@^4`, whose Vite peer range excludes the `vite@8` the template also pins, so npm 10 arborist aborts (npm 11 resolved it, hiding the bug); moved to `vitest@^5`. Also adds structured repair hints to `doctor` failure output. **Non-breaking**; same CRD (`v1alpha1`) and operator bundle as `0.4.1`. Upgrade operator/CRD first, then CLI. |
| `0.4.1` | `apps.kn-next.dev/v1alpha1` | `operator-latest` | republish of the `0.4.0` content as an installable set. `0.4.0` shipped tarballs whose `@getknext/*` sibling ranges were left as the internal `workspace:` protocol, so `npm install` failed with `EUNSUPPORTEDPROTOCOL`; `@latest` was rolled back to `0.3.1`. The publish now rewrites those ranges to concrete versions and verifies the packed tarballs before publishing. Same **breaking** metrics-port change as `0.4.0` (see the note below). Upgrade operator/CRD first, then CLI. |
| `0.4.0` (yanked) | `apps.kn-next.dev/v1alpha1` | `operator-latest` | first npm release with all four version-locked together — **uninstallable** (`workspace:` ranges shipped verbatim); superseded by `0.4.1`. **Breaking:** the app metrics-port default moves `9091` → `9464` — on a stock Knative install the queue-proxy binds `9091`, so an app defaulting there crash-looped with `EADDRINUSE`. knext’s own annotation, NetworkPolicy, PodMonitor and dashboards repoint automatically; any external scrape config, self-written ServiceMonitor/PodMonitor, Grafana query or NetworkPolicy pinned to `:9091` must move to `:9464`. Upgrade operator/CRD first, then CLI. |
| `0.3.1` (in tree) | `apps.kn-next.dev/v1alpha1` | `operator-latest` | current `main`; the first set where all **four** move together — `kn-next`, the `npx` alias, joins the version-locked group |
| `0.3.0` (in tree) | `apps.kn-next.dev/v1alpha1` | `operator-latest` | the three are version-locked from this release on |
| `@getknext/core@0.3.0`, `@getknext/lib@0.2.0`, `@getknext/db@0.2.1` (published 2026-07-26) | `apps.kn-next.dev/v1alpha1` | `operator-latest` | the first npm release; the three published at **different** numbers — see "the drift" below |

Every row so far names the same CRD `apiVersion`, which is the point: within `v1alpha1` the schema
is additive-only, so no released package set has ever needed a *newer* CRD than another.

### Reading a row

- **Package set** — the number you pin. One number covers all three packages.
- **CRD `apiVersion`** — the value a hand-authored or GitOps-managed `NextApp` must carry, and the
  value the CLI emits. Verified mechanically against both the ADR that declares it and the CRD
  manifests the operator actually serves.
- **Operator bundle** — where the matching operator comes from. Today there is exactly one address:

  ```sh
  kubectl apply -f https://github.com/getknext-dev/knext/releases/download/operator-latest/install.yaml
  ```

### The drift, recorded rather than tidied away

The first npm release published the three at **different** version numbers. That is inconsistent
with the "ship as a set" rule those same release notes stated, and it is why the rule is now
mechanical (a Changesets `fixed` group plus the guard) rather than a promise. The published set is
internally consistent — `@getknext/core@0.3.0` depends on `@getknext/lib@^0.2.0` and
`@getknext/db@^0.2.1`, both of which exist — so nothing is broken for a consumer; from the next
release on, one number covers all three.

## Upgrade order

**Upgrade the operator (and therefore the CRD) BEFORE the CLI: operator/CRD first, then CLI.**

An **older CLI against a newer CRD is always valid** — a client that emits a subset of the schema
never trips unknown-field validation — so the two are *not* required to be in lockstep. Only the
reverse (CLI ahead of CRD) is unsupported.

The runbook, the exact apiserver error, and the residual gaps strict validation does *not* close are
in [`docs/RELEASING.md`](RELEASING.md#upgrade-order); the decision is ADR-0020.

## What is checked mechanically, and what is not

Checked (`tests/release-policy-matrix.test.ts`, plus
`packages/kn-next/src/__tests__/crd-api-version.test.ts`):

- the three published packages carry one version, and Changesets is configured to keep it that way;
- no fourth publishable package exists — the workspace is **scanned**, not enumerated;
- **every row's** CRD `apiVersion` cell equals the one ADR-0017 declares **and** the one the
  operator's generated CRD manifests + Go API package actually serve (per row, parsed out of the
  table — an earlier whole-file substring check passed with either cell falsified);
- the CLI names no other CRD `apiVersion` anywhere under `src/cli/`;
- a row exists for the version currently in the tree.

Checked at deploy time, in the CLI: the schema preflight (`src/cli/schema/preflight.ts`) compares
the fields this CLI emits against the CRD installed on the target cluster and refuses **before any
side effect** if the cluster cannot store one, naming the field.

**Not** checked, stated so nobody assumes otherwise:

- **the operator has no semver release line.** Its images are tagged by commit SHA and pinned by
  digest in the bundle; `operator-latest` is re-pointed at `main` on each publish. So "minimum
  operator version" cannot be expressed as a number today, and the matrix cannot assert one. The
  practical protection is the ordering rule plus the deploy-time preflight above — not this table.
- **nothing here verifies a registry.** The guard reads this repo; it cannot confirm what is
  actually installed on npm or in a cluster.
- **the prose is checked at heading and name level, not for correctness.** The policy and the
  user-facing page are asserted to have their sections and to name the three packages — a stub
  satisfying that would pass. These checks catch deletion, not a wrong claim.
