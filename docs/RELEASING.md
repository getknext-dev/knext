# Releasing knext (maintainer runbook)

> Internal maintainer doc. Describes how knext's npm packages are published via Changesets +
> GitHub Actions. This is NOT the user-facing docs site — it may reference issues and workflow
> internals. Related: issue #53 (first npm publish, the #1 adoption blocker).
>
> Two paths exist: (a) the **canonical npmjs path** (`@knext/*`, Changesets → `release.yml`,
> blocked on a human `NPM_TOKEN`) documented first, and (b) an **interim GitHub Packages channel**
> (`@getknext-dev/*`, `release-ghp.yml`) for use until npmjs goes live — see
> [Interim channel — GitHub Packages](#interim-channel--github-packages-getknext-dev).

## What publishes

Publishing is driven by [Changesets](https://github.com/changesets/changesets) and the
`.github/workflows/release.yml` workflow. Only two packages are published to the public npm
registry:

| Package       | Path               | Public? | Provenance |
| ------------- | ------------------ | ------- | ---------- |
| `@knext/core` | `packages/kn-next` | yes     | yes        |
| `@knext/lib`  | `packages/lib`     | yes     | yes        |

Both carry `"publishConfig": { "access": "public", "provenance": true }`, so `changeset publish`
publishes them publicly and CI attaches a signed provenance attestation (via the workflow's
`id-token: write` permission).

**Does NOT publish:**

- `@knext/ui`, `file-manager`, `spike-bun-bytecode` — listed in `ignore` in
  `.changeset/config.json`, so Changesets never versions or publishes them.
- `apps/*` — private application code, not libraries.
- The Go operator (`packages/kn-next-operator`) — released as a container image, not via npm.

## The gate (safe by default)

`release.yml` runs on every push to `main` and on manual `workflow_dispatch`. It computes a
publish gate in the "Determine publish gate" step:

- **If `NPM_TOKEN` is set** as a repo secret → the `publish` input is `pnpm run release`
  (`changeset publish`), so CI can publish.
- **If `NPM_TOKEN` is unset** → the `publish` input is empty. `changesets/action` can then only
  open/update the "Version Packages" PR. It will NEVER run `changeset publish`.

So until a maintainer configures auth (Path A or Path B below), the Release workflow is a no-op
for publishing — it is safe by default and cannot accidentally publish.

## First publish (0.1.0) — exact human steps

The first publish ships the current **0.1.0** directly. There are intentionally **no pending
changesets**: when `.changeset/*.md` is empty, `changesets/action` skips the Version PR and runs
`changeset publish` directly, publishing the unpublished `@knext/core@0.1.0` and
`@knext/lib@0.1.0`. (Adding a changeset here would wrongly open a Version PR that bumps past
0.1.0 before the first release — do not add one.)

### Step 1 — Claim the npm org (required for both auth paths)

On [npmjs.com](https://www.npmjs.com/), create/claim the npm **organization `knext`**. This owns
the `@knext` scope. Without it, publishing any `@knext/*` package fails.

### Step 2 — Set up auth

Two options. **Use Path A for the FIRST publish**, because npm OIDC Trusted Publishing (Path B)
can only be configured on an **already-existing** package — there is nothing to point a trusted
publisher at until the package exists.

#### Path A — `NPM_TOKEN` (recommended for the first publish)

1. On npmjs.com, create a **Granular Access / Automation token** scoped to the `@knext` packages
   with **read + write** permission.
2. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**,
   name it exactly `NPM_TOKEN`, paste the token.
3. Trigger a release: either push any commit to `main`, OR run the **Release** workflow manually
   (**Actions → Release → Run workflow**, i.e. `workflow_dispatch`).
4. With `NPM_TOKEN` present and no pending changesets, `changesets/action` runs `changeset
   publish`, publishing `@knext/core@0.1.0` and `@knext/lib@0.1.0` with provenance.

#### Path B — OIDC Trusted Publishing (migrate to this AFTER the first publish)

Once the packages exist on npm, you can drop the long-lived `NPM_TOKEN` secret:

1. On npmjs.com, open each package's settings and configure its **Trusted Publisher** = this repo
   (`getknext-dev/knext`) + the `release.yml` workflow.
2. The workflow already grants `id-token: write`, so CI can then publish with **no stored token**.
3. Remove the `NPM_TOKEN` repo secret after confirming an OIDC publish succeeds.

### Step 3 — Verify

```sh
npm view @knext/core version   # → 0.1.0
npm view @knext/lib version    # → 0.1.0
npx @knext/core --help         # from a clean directory (the published bin is kn-next)
```

> Note on invocation: the **npm package** is `@knext/core`; its **bin** is `kn-next`. There is no
> package literally named `kn-next` on npm, so the published-package invocation is
> `npx @knext/core <subcommand>` (npx resolves the package and runs its single `kn-next` bin).
> `npx kn-next` only works once a package by that exact name exists — it does not.

Also confirm both packages show a provenance / "Published via GitHub Actions" badge on npmjs.com.

## Subsequent releases

The normal flow after the first publish:

1. A feature PR includes a changeset: run `pnpm changeset`, describe the change, commit the
   generated `.changeset/*.md`.
2. Merging that PR to `main` makes `changesets/action` open (or update) a **"Version Packages"**
   PR that applies the version bumps and updates changelogs.
3. Merging the **"Version Packages"** PR (a second push to `main`) runs `changeset publish` and
   publishes the bumped versions. The workflow also creates one **GitHub Release** per published
   package (`createGithubReleases: true`), tagged `@knext/<pkg>@x.y.z` — the hand-made `v0.1.0`
   release used a different tag format, so the formats never collide.

## Interim channel — GitHub Packages (`@getknext-dev/*`)

Until the npmjs path above is unblocked (it needs a human `NPM_TOKEN`, issue #53), the maintainer
directive is to ship an **interim** release channel on **GitHub Packages**
(`npm.pkg.github.com`). This is a stopgap — **`@knext/*` on npmjs remains the canonical future
home**; the GHP names are temporary.

### Why the packages are renamed

GitHub Packages requires the package **scope to match the owning org**, and `publishConfig` cannot
override a package name or a dependency name. So this channel republishes under the org scope:

| npmjs (canonical) | GitHub Packages (interim) |
| ----------------- | ------------------------- |
| `@knext/core`     | `@getknext-dev/core`      |
| `@knext/lib`      | `@getknext-dev/lib`       |

The rename is done by `scripts/rename-for-ghp.mjs`, which stages **copies** (it never mutates the
working tree) and rewrites:

- each package `name` → `@getknext-dev/*`;
- core's inter-package dependency key `@knext/lib` → `@getknext-dev/lib`, and any `workspace:`
  specifier → a concrete version range (since `npm publish` from a staging dir cannot rewrite the
  pnpm `workspace:` protocol like `pnpm publish` would);
- **every hardcoded `@knext/` import string inside the staged `dist/**`** — this is the critical
  hazard: `@knext/lib` is externalized in `packages/kn-next/tsup.config.ts`, so core's compiled
  output (`dist/adapters/node-server.js`, `dist/adapters/next-adapter.js`) contains literal
  `@knext/lib/clients` imports. Renaming only `package.json` would publish an `@getknext-dev/core`
  whose runtime imports the never-published `@knext/lib`. The script **fails loudly** if core's
  dist contains zero `@knext/` occurrences (a signal the externalization layout changed);
- `publishConfig.provenance` is **stripped** — provenance needs npmjs/OIDC and fails on GHP.

### Publishing

Run the **Release (GitHub Packages, interim)** workflow manually
(**Actions → Release (GitHub Packages, interim) → Run workflow**). It builds `@knext/lib` then
`@knext/core`, stages the renamed copies, and publishes **lib before core** to
`npm.pkg.github.com` using the built-in `GITHUB_TOKEN` (`packages: write`, no id-token). Re-running
with an unchanged version fails with a clear "already published — bump versions via changesets
first" message; bump versions before re-releasing.

### Consuming `@getknext-dev/*` from GitHub Packages

GHP requires auth for installs **even for public packages**. In the consuming project add an
`.npmrc`:

```ini
@getknext-dev:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

where `GITHUB_TOKEN` is a personal access token with the `read:packages` scope. Then:

```sh
npm install @getknext-dev/core @getknext-dev/lib
npx @getknext-dev/core --help    # runs the kn-next bin from the GHP package
```

> Caveat: anonymous installs get a `401` — the auth line above is mandatory. Once the npmjs
> release goes live, migrate consumers back to `npx @knext/core` / `@knext/*`; the GHP scope is
> interim only.

### Deprecation plan for `@getknext-dev/*` (execute when npmjs goes live)

Decided 2026-07 (architect sign-off on the interim channel): the GHP scope is **deprecated the
day `@knext/*` publishes to npmjs** (issue #53). When that happens, a maintainer should:

1. Publish one final `@getknext-dev/*` patch whose README/description points at `@knext/*` on
   npmjs, **or** simply mark the existing GHP versions deprecated:

   ```sh
   npm deprecate @getknext-dev/core "moved to @knext/core on registry.npmjs.org" \
     --registry=https://npm.pkg.github.com
   npm deprecate @getknext-dev/lib "moved to @knext/lib on registry.npmjs.org" \
     --registry=https://npm.pkg.github.com
   ```

2. Stop dispatching `release-ghp.yml` (leave the workflow in place for history; it is manual-only
   so it cannot fire accidentally).
3. Update this doc and any consumer `.npmrc` snippets to the `@knext/*` install path.

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
- **Workflow ran but nothing published.** Check the "Determine publish gate" step log. If it says
  "NPM_TOKEN not set", the gate is off — set the secret (Path A) or configure a trusted publisher
  (Path B).
