# Releasing knext (maintainer runbook)

> Internal maintainer doc. Describes how knext's npm packages are published via Changesets +
> GitHub Actions. This is NOT the user-facing docs site — it may reference issues and workflow
> internals. Related: issue #53 (publish mechanics).
>
> This file is the **mechanics**. The **policy** those mechanics serve — release cadence, what a
> version number promises, the support window, and the deprecation process — is
> [`docs/RELEASE_POLICY.md`](RELEASE_POLICY.md), and the version-by-version compatibility table is
> [`docs/COMPATIBILITY.md`](COMPATIBILITY.md).
>
> Two paths exist: (a) the **canonical npmjs path** (`@getknext/*`, Changesets → `release.yml`)
> documented first, and (b) an **interim GitHub Packages channel**
> (`@getknext-dev/*`, `release-ghp.yml`) — see
> [Interim channel — GitHub Packages](#interim-channel--github-packages-getknext-dev).
>
> **Auth is configured.** This file used to say the npmjs path was "blocked on a human `NPM_TOKEN`".
> It is not, and was not since 2026-07-25 — see [The gate](#the-gate-two-lanes-one-approval) for
> where the token actually lives and what genuinely needs a human.

## What publishes

Publishing is driven by [Changesets](https://github.com/changesets/changesets) and the
`.github/workflows/release.yml` workflow. Four packages are published to the public npm registry:

| Package          | Path                      | Public? | Provenance |
| ---------------- | ------------------------- | ------- | ---------- |
| `@getknext/core` | `packages/kn-next`        | yes     | yes        |
| `@getknext/lib`  | `packages/lib`            | yes     | yes        |
| `@getknext/db`   | `packages/db`             | yes     | yes        |
| `kn-next`        | `packages/kn-next-alias`  | yes     | yes        |

`@getknext/core` depends on **both** `@getknext/lib` and `@getknext/db` (and `@getknext/db` depends on
`@getknext/lib`), so they must always ship as a set — publishing core without db is exactly
the #255/#256 incident (every consumer install 404s on the missing member). `kn-next` is the alias
package that makes the bare `npx kn-next` resolve; it forwards to `@getknext/core`'s CLI and joined
the `fixed` group in #820, so all four now move to the same version together.

All four carry `"publishConfig": { "access": "public", "provenance": true }`, so `changeset publish`
publishes them publicly and CI attaches a signed provenance attestation (via the workflow's
`id-token: write` permission).

**Does NOT publish:**

- `@getknext/ui`, `file-manager`, `spike-bun-bytecode` — listed in `ignore` in
  `.changeset/config.json`, so Changesets never versions or publishes them.
- `apps/*` — private application code, not libraries.
- The Go operator (`packages/kn-next-operator`) — released as a container image, not via npm.

## The gate (two lanes, one approval)

`release.yml` runs on every push to `main` and on manual `workflow_dispatch`, as **three jobs**:

| job | environment | credential | what it does |
| --- | --- | --- | --- |
| `audit` | — | — | npm supply-chain audit + SBOM. Publish-blocking. |
| `version-pr` | **none** | **none** | opens/updates the "Version Packages" PR. Passes no `publish-script`, so it *cannot* publish. |
| `publish-preflight` | none | none | runs `scripts/publish-preflight.mjs` — is any version in the tree absent from the registry? |
| `release` | `npm-publish` | `NODE_AUTH_TOKEN` | the only job that publishes. **Skipped** unless there are no pending changesets *and* something is genuinely unpublished. |

`NPM_TOKEN` is an **environment secret on `npm-publish`** — not a repo secret, which is why a plain
`gh secret list` does not show it. That environment carries a **required-reviewer** rule, so the
publish itself waits for a human click. That is deliberate: publishing to a public registry is
irreversible.

**Opening a Version PR does not wait for anything.** It used to: `version-pr` and `release` were one
job that declared the environment, so every push to `main` asked for an approval — including pushes
that only wanted to open a PR. One un-clicked approval on 2026-07-26 (run `30207128316`) then parked
in `waiting`, held the workflow-level concurrency group, and every subsequent run was cancelled in
the queue — 99 of 100, each with zero jobs. Nothing published for a month. The split, the per-job
concurrency groups, and the job-level `if:` on `release` exist to make that impossible; see
`tests/release-lane-liveness.test.ts`.

The gate also runs `npm whoami` before publishing and fails loudly if the token is present but
rejected. Presence is not validity.

## First publish — DONE (2026-07-26)

**The first npmjs publish has happened.** Verified against the registry:

| Package          | Published version | Date       |
| ---------------- | ----------------- | ---------- |
| `@getknext/core` | `0.3.0`           | 2026-07-26 |
| `@getknext/lib`  | `0.2.0`           | 2026-07-26 |
| `@getknext/db`   | `0.2.1`           | 2026-07-26 |

Two things to know before reading the steps below, which are kept as the record of how it was done
(and as the runbook for re-establishing auth):

- **The three shipped at different version numbers.** That contradicts the ship-as-a-set rule those
  releases themselves stated. The published set is internally consistent (`@getknext/core@0.3.0`
  depends on `@getknext/lib@^0.2.0` and `@getknext/db@^0.2.1`, both published), so no consumer is
  broken — but from the next release on the three are a Changesets **`fixed` group** and move
  together. See [`docs/COMPATIBILITY.md`](COMPATIBILITY.md).
- **`npx kn-next` still does not resolve.** The bin is `kn-next`; the package is `@getknext/core`.
  There is no npm package literally named `kn-next`, so the published invocation is
  `npx @getknext/core <subcommand>`.

### Step 1 — the npm org (record; required for both auth paths)

The npm **organization `getknext`** owns the `@getknext` scope. Without it, publishing any
`@getknext/*` package fails.

### Step 2 — Set up auth

Two options. Path A was used for the first publish, because npm OIDC Trusted Publishing (Path B)
can only be configured on an **already-existing** package — there was nothing to point a trusted
publisher at until the packages existed. **Now that they exist, Path B is the migration to make.**

#### Path A — `NPM_TOKEN` (what the first publish used)

1. On npmjs.com, create a **Granular Access / Automation token** scoped to the `@getknext` packages
   with **read + write** permission.
2. In the GitHub repo: **Settings → Environments → `npm-publish` → Environment secrets → Add**,
   name it exactly `NPM_TOKEN`, paste the token. **The environment, not the repo** — the `release`
   job declares `environment: npm-publish`, and only that environment's secrets reach it. Putting it
   in repo secrets instead would leave `secrets.NPM_TOKEN` empty and the gate would fail with
   "NPM_TOKEN is not set on the npm-publish environment".
3. Trigger a release: either push any commit to `main`, OR run the **Release** workflow manually
   (**Actions → Release → Run workflow**, i.e. `workflow_dispatch`).
4. With no pending changesets and something genuinely unpublished, `release` starts, waits for the
   environment approval, verifies the token with `npm whoami`, then runs `changeset publish` —
   publishing every package whose tree version is not already on the registry, with provenance.

#### Path B — OIDC Trusted Publishing (migrate to this AFTER the first publish)

Once the packages exist on npm, you can drop the long-lived `NPM_TOKEN` secret:

1. On npmjs.com, open each package's settings and configure its **Trusted Publisher** = this repo
   (`getknext-dev/knext`) + the `release.yml` workflow.
2. The workflow already grants `id-token: write`, so CI can then publish with **no stored token**.
3. Remove the `NPM_TOKEN` environment secret after confirming an OIDC publish succeeds — and note
   that the gate step fails closed on an absent token, so remove it only once OIDC is proven, and
   drop the gate's presence check in the same change.

### Step 3 — Verify

```sh
npm view @getknext/core version   # → the version just released
npm view @getknext/lib version    # → the same version (they are a `fixed` group)
npm view @getknext/db version     # → the same version
npm view kn-next version          # → the same version (the alias joined the group in #820)
npx kn-next --help                # from a clean directory
```

Or, from a checkout, ask the same question the release lane asks:

```sh
node scripts/publish-preflight.mjs   # prints a per-package table; exits 1 if the registry is unreachable
```

All four must report the same number. If one is missing or behind, the set is partial and every
consumer install 404s or resolves the wrong pair — publish the stragglers before doing anything
else.

> Note on invocation: the **npm package** carrying the code is `@getknext/core` and its **bin** is
> `kn-next`. `npx kn-next` works via the `kn-next` alias package (`packages/kn-next-alias`), which
> exists only to forward to that bin. Until the alias has been published at least once,
> `npx kn-next` 404s and the published-package invocation is `npx @getknext/core <subcommand>`.

Also confirm each package shows a provenance / "Published via GitHub Actions" badge on npmjs.com.

## Subsequent releases

The normal flow after the first publish:

1. A feature PR includes a changeset: run `pnpm changeset`, describe the change, commit the
   generated `.changeset/*.md`.
2. Merging that PR to `main` makes `version-pr` open (or update) a **"Version Packages"** PR that
   applies the version bumps and updates changelogs. **No approval is involved.**
3. Merging the **"Version Packages"** PR is a second push to `main`. `version-pr` now reports no
   changesets, `publish-preflight` finds versions the registry does not have, and `release` starts —
   at which point GitHub requests the `npm-publish` **deployment approval**.
4. **A maintainer approves it** ("Review deployments" on the run, or
   <https://github.com/getknext-dev/knext/deployments>). `changeset publish` then runs, and the
   workflow creates one **GitHub Release** per published package (`create-github-releases: true`),
   tagged `@getknext/<pkg>@x.y.z` — the hand-made `v0.1.0` release used a different tag format, so
   the formats never collide.

Step 4 is the only human step in the loop, and it is the correct one: it is the point at which
something irreversible happens. If a run is sitting in `waiting`, **check its head SHA before
approving** — approving a stale parked run publishes the tree as it stood when that run started.

## Upgrade order

**Upgrade the operator (and therefore the CRD) BEFORE upgrading `@getknext/core`: operator/CRD
first, then CLI.** This is an ordering rule, not a lockstep requirement — see the safe direction
below.

### Why

`kn-next` emits a `NextApp` custom resource and applies it with an explicit `--validate=strict`
(so the guarantee is knext's, not a property of whichever `kubectl` happens to be on `PATH`). A
newer CLI can emit a spec field that an older CRD's schema does not contain, and with strict
validation the apiserver **rejects** that apply rather than silently pruning the field:

```
Error from server (BadRequest): error when creating "…": NextApp in version "v1alpha1" cannot be
handled as a NextApp: strict decoding error: unknown field "spec.…"
```

If you see `strict decoding error: unknown field` on `kn-next deploy`, `kn-next preview`, or
`kn-next db bind`, the most likely cause is that the CLI is newer than the installed CRD. Fix it by
upgrading the operator bundle first, then re-running:

```sh
kubectl apply -f https://github.com/getknext-dev/knext/releases/download/operator-latest/install.yaml
kubectl get crd nextapps.apps.kn-next.dev -o jsonpath='{.spec.versions[*].name}'
```

The rejection is deliberate and is the better failure: before the CLI asserted strict validation,
the wrong order produced a **silently pruned** field — the apply exited 0, the CR looked applied,
and the setting simply never took effect.

### The safe direction

**An older CLI against a newer CRD is always valid**, so you are not required to keep the two in
lockstep — only to avoid CLI-ahead-of-CRD. Unknown-field validation is one-directional: it rejects
fields the schema does not know, and a client that emits a *subset* of the schema never trips it. A
cluster whose operator is ahead of every developer's CLI is a fine steady state.

### What strict validation does NOT buy

Stated plainly, because these are the reason the ordering rule matters rather than being a nicety:

- **GitOps controllers do not assert strict validation.** If Argo CD or Flux applies your `NextApp`
  CRs, the strict flag `kn-next` passes is not in play; an unknown field is pruned silently there,
  exactly as it was before. Ordering is your only protection on that path.
- **A `kubectl` shim on `PATH` can defeat it.** `kn-next` passes `--validate=strict`, but a wrapper
  that appends `--validate=ignore` wins, because pflag takes the **last** occurrence of a string
  flag.
- **`kn-next doctor` on its own does not prove the CRD covers what this CLI emits.** The
  schema-diff preflight that closes this now exists (`src/cli/schema/preflight.ts`): `kn-next
  deploy` compares the fields this CLI emits against the CRD installed on the target cluster and
  refuses **before any side effect**, naming the missing field. It runs at deploy time against the
  cluster in front of it — it is not a substitute for upgrading in the right order, and it does not
  help a GitOps controller applying CRs without the CLI.

The decision and its measured basis are recorded in
[ADR-0020](adr/0020-release-channels.md#amendment-2026-07-28--upgrade-order-operatorcrd-first-then-cli).

## Interim channel — GitHub Packages (`@getknext-dev/*`)

Introduced while the npmjs path was believed to be blocked on auth (issue #53), the maintainer
directive was to ship an **interim** release channel on **GitHub Packages**
(`npm.pkg.github.com`). This is a stopgap — **`@getknext/*` on npmjs remains the canonical future
home**; the GHP names are temporary.

### Why the packages are renamed

GitHub Packages requires the package **scope to match the owning org**, and `publishConfig` cannot
override a package name or a dependency name. So this channel republishes under the org scope:

| npmjs (canonical) | GitHub Packages (interim) |
| ----------------- | ------------------------- |
| `@getknext/core`     | `@getknext-dev/core`      |
| `@getknext/lib`      | `@getknext-dev/lib`       |
| `@getknext/db`       | `@getknext-dev/db`        |

The rename is done by `scripts/rename-for-ghp.mjs`, which stages **copies** (it never mutates the
working tree) and rewrites:

- each package `name` → `@getknext-dev/*`;
- the inter-package dependency keys (`@getknext/lib`, `@getknext/db`) → `@getknext-dev/*`, and any
  `workspace:` specifier → a concrete version range (since `npm publish` from a staging dir
  cannot rewrite the pnpm `workspace:` protocol like `pnpm publish` would);
- **every hardcoded `@getknext/` import string inside the staged `dist/**`** — this is the critical
  hazard: `@getknext/lib` **and `@getknext/db`** are externalized in
  `packages/kn-next/tsup.config.ts` (and `@getknext/db`'s plain-tsc build preserves its
  `@getknext/lib` imports), so the compiled outputs (`dist/adapters/node-server.js`,
  `dist/cli/db-migrate.js`, `packages/db/dist/index.js`) contain literal `@getknext/lib/...` +
  `@getknext/db/...` imports. Renaming only `package.json` would publish packages whose runtime
  imports the never-published `@getknext/*` names. The script **fails loudly, per dependency**: for
  every `@getknext/*` dep a staged package declares, its dist must contain at least one occurrence
  of that exact specifier (a zero signals the externalization layout changed). It also refuses
  any `@getknext/*` dependency that is not itself in the publish set;
- `publishConfig.provenance` is **stripped** — provenance needs npmjs/OIDC and fails on GHP.

### Publishing

Run the **Release (GitHub Packages, interim)** workflow manually
(**Actions → Release (GitHub Packages, interim) → Run workflow**). It builds `@getknext/lib`, then
`@getknext/db`, then `@getknext/core`, stages the renamed copies, and publishes **lib, then db, then
core** to `npm.pkg.github.com` using the built-in `GITHUB_TOKEN` (`packages: write`, no id-token). Re-running
with an unchanged version fails with a clear "already published — bump versions via changesets
first" message; bump versions before re-releasing.

After publish, the workflow's `smoke-ghp` job runs `scripts/ghp-install-smoke.mjs`, which
installs the just-published `@getknext-dev/*` FROM `npm.pkg.github.com` as a real consumer would
(`GITHUB_TOKEN` + `packages: read`) and asserts the CLI + app-import surface — so a maintainer
dispatch of `release-ghp.yml` yields the first live green proving the channel is installable, not
just packable.

### Consuming `@getknext-dev/*` from GitHub Packages

GHP requires auth for installs **even for public packages**. In the consuming project add an
`.npmrc`:

```ini
@getknext-dev:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

where `GITHUB_TOKEN` is a personal access token with the `read:packages` scope. Then:

```sh
npm install @getknext-dev/core @getknext-dev/lib @getknext-dev/db
npx @getknext-dev/core --help    # runs the kn-next bin from the GHP package
```

> Caveat: anonymous installs get a `401` — the auth line above is mandatory. Once the npmjs
> release goes live, migrate consumers back to `npx @getknext/core` / `@getknext/*`; the GHP scope is
> interim only.

### Deprecation plan for `@getknext-dev/*` (execute when npmjs goes live)

Decided 2026-07 (architect sign-off on the interim channel): the GHP scope is **deprecated the
day `@getknext/*` publishes to npmjs** (issue #53). When that happens, a maintainer should:

1. Publish one final `@getknext-dev/*` patch whose README/description points at `@getknext/*` on
   npmjs, **or** simply mark the existing GHP versions deprecated:

   ```sh
   npm deprecate @getknext-dev/core "moved to @getknext/core on registry.npmjs.org" \
     --registry=https://npm.pkg.github.com
   npm deprecate @getknext-dev/lib "moved to @getknext/lib on registry.npmjs.org" \
     --registry=https://npm.pkg.github.com
   ```

2. Stop dispatching `release-ghp.yml` (leave the workflow in place for history; it is manual-only
   so it cannot fire accidentally).
3. Update this doc and any consumer `.npmrc` snippets to the `@getknext/*` install path.

Do **not** unpublish the GHP versions — existing consumers keep working; deprecation warns them
to migrate.

## Troubleshooting

- **Dirty local tree with conflict markers.** The local `main` working tree may carry a stale
  git stash that left merge-conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) in some
  `package.json` files. CI publishes from a clean `main` HEAD and is unaffected, but a maintainer
  running a **local** `pnpm publish` from a dirty tree would ship broken JSON. Before any local
  publish, verify the tree is clean:

  ```sh
  git status
  grep -rn '<<<<<<<\|>>>>>>>\|=======' packages/*/package.json   # must print nothing
  git checkout -- .   # if you need to discard the stray markers
  ```

  Prefer the CI publish path; it is always cut from a clean checkout.
- **Workflow ran but nothing published.** Work down the three jobs, in order:
  1. **`release` was skipped.** Read `publish-preflight`'s step summary — it prints a per-package
     table. Either there are still pending changesets (merge the Version PR first) or every version
     in the tree is already on the registry (there is genuinely nothing to publish).
  2. **`release` is sitting in `waiting`.** It is asking for the `npm-publish` environment approval.
     Click "Review deployments" on the run — and check its head SHA first; approving a stale parked
     run publishes that old tree.
  3. **The gate step failed.** "NPM_TOKEN is not set" → the secret is missing from the **environment**
     (not the repo — see Path A step 2). "present but REJECTED" → the token exists but npm refused
     it; rotate it, or configure a trusted publisher (Path B).
- **Every run shows `cancelled` with zero jobs.** Something is parked in the concurrency queue.
  `gh api "repos/getknext-dev/knext/actions/workflows/release.yml/runs?status=waiting"` names it.
  Cancel the parked run — do not approve it — and check that nothing has reintroduced a
  **workflow-level** `concurrency:` block, which is what made a single parked run starve the whole
  lane for a month in 2026-08.
