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
> There is one publish path: the **canonical npmjs path** (`@getknext/*`, Changesets →
> `release.yml`). The former interim GitHub Packages channel (`@getknext-dev/*`,
> `release-ghp.yml`) is retired — see
> [Retired: interim GitHub Packages channel](#retired-interim-github-packages-channel-getknext-dev).
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

`release.yml` runs on every push to `main` and on manual `workflow_dispatch`, as **six jobs**:

| job | environment | credential | what it does |
| --- | --- | --- | --- |
| `pack` | — | — | packs the `@getknext/*` fixed group **once**, with `npm pack` (the real publish tool), and uploads it as the `release-tarballs` artifact. See "pack once" below. |
| `audit` | — | — | npm supply-chain audit + SBOM. Publish-blocking. Packs its **own** `bun pm pack` (a stale-lock detector, not the same concern) and a second `npm pack` from its own build for the actual audit target — deliberately NOT the `pack` job's artifact; see below. |
| `version-pr` | **none** | **none** | opens/updates the "Version Packages" PR. Passes no `publish-script`, so it *cannot* publish. |
| `publish-preflight` | none | none | runs `scripts/publish-preflight.mjs` — is any version in the tree absent from the registry? |
| `ga-tarball-diff` | none | none | runs `scripts/ga-tarball-diff-gate.mjs` — a credentialed GA cut must differ from its last rc only in version fields; see below. Publish-blocking. Diffs the ga/HEAD side against the `pack` job's artifact rather than re-packing HEAD. |
| `release` | `npm-publish` | `NODE_AUTH_TOKEN` | the only job that publishes. **Skipped** unless there are no pending changesets *and* something is genuinely unpublished. Verifies its own fresh pre-publish pack against the `pack` job's artifact byte-for-byte before using the token. |

`NPM_TOKEN` is an **environment secret on `npm-publish`** — not a repo secret, which is why a plain
`gh secret list` does not show it. **As of this writing, that environment carries no protection
rule** — the API returns an empty list, and `1.0.0-rc.1`/`1.0.0-rc.2` both published with no
reviewer click. Adding a required-reviewer rule (plus `v*` tag protection) is the founder action
tracked by #1638; a release run does not pause for approval today, and the GA-cut runbook below
should not be read as assuming one exists until #1638 lands.

**Opening a Version PR does not wait for anything.** It used to: `version-pr` and `release` were one
job that declared the environment, so every push to `main` asked for an approval — including pushes
that only wanted to open a PR. One un-clicked approval on 2026-07-26 (run `30207128316`) then parked
in `waiting`, held the workflow-level concurrency group, and every subsequent run was cancelled in
the queue — 99 of 100, each with zero jobs. Nothing published for a month. The split, the per-job
concurrency groups, and the job-level `if:` on `release` exist to make that impossible; see
`tests/release-lane-liveness.test.ts`.

The gate also runs `npm whoami` before publishing and fails loudly if the token is present but
rejected. Presence is not validity.

### The packed tarball must be able to scaffold

A published `@getknext/core` whose tarball omits the `create` verb or the `templates/` directory is
worse than a broken release — it publishes green and the front door (`npx kn-next create`) is dead
for every stranger, with nothing in the release lane objecting. That is exactly what shipped in
`0.3.0`: its tarball carried no `dist/cli/create.js` and zero `templates/` entries.

Three layers now assert the tarball can scaffold, form-at-PR-time / value-at-run-time:

- **PR-time (fast, no publish):** `tests/scaffold-pack-contents.test.ts` feeds the real
  `npm pack --dry-run` manifest of `packages/kn-next` to `scaffoldPackProblems`
  (`scripts/scaffold-pack-contents.mjs`) and reds if the `create` bundle or any template is missing,
  and separately pins the config chain that lands `create` in `dist` (the `files` allowlist, the
  `cli/create` tsup entry, the bin's `create` dispatch). A `files`/tsup regression cannot merge.
- **Run-time (packs + installs + scaffolds):** `scripts/install-smoke.mjs` scaffolds from the
  packed-and-installed package in a clean, Bun-free dir.
- **Stranger, against the live registry:** the `verify-scaffold-install.mjs` nightly runs the
  documented `npm exec --package=@getknext/core@latest -- kn-next create` quickstart.

### A credentialed GA must differ from its last rc ONLY in version fields

The v1.0 compatibility credential is measured against a specific `rc.N` git tag's tarballs — the
ones the compat suite actually installed and exercised for 14 nights. Nothing else connects that
measurement to what `changeset publish` ships next. If the tarball published under the GA cut
differs from that rc in anything beyond version fields, the credential does not cover the artifact
users install.

`scripts/ga-tarball-diff.mjs` (`scripts/lib/ga-tarball-diff.mjs` has the precise comparison rules)
proves this: it packs both sides — `@getknext/core`, `@getknext/lib`, `@getknext/db` **and the
unscoped `kn-next` npx alias** (same `fixed` group, ships at GA) — and fails on any delta that
isn't a version field, a co-versioned `@getknext/*` sibling range, or the exact version string
substituted wherever it is embedded in a built file's bytes. `scripts/ga-tarball-diff-gate.mjs` is
the `release.yml` wiring that decides *when* to run it, from the **git tags**, not from `rcTag` in
`.github/compat-credential-ref.json` (which is the credential window's live pin and is cleared when
the window closes — exactly when GA is cut):

| target version | `vX.Y.Z-rc.N` tags for that `X.Y.Z` | outcome |
| --- | --- | --- |
| any prerelease (`1.0.0-rc.3`, `2.0.0-beta.0`) | — | **skip** by design — a later rc is *expected* to carry real changes |
| GA `X.Y.Z` | none (e.g. `1.0.1`, `1.1.0`, `2.0.0`) | **skip** — "no release candidate was cut for X.Y.Z — this release is not claimed as credentialed". Never blocks the release. |
| GA `X.Y.Z` | one or more | **run** — diff the **highest** `vX.Y.Z-rc.N` (numeric) against `HEAD`; a non-zero exit blocks `release` |
| GA `X.Y.Z` | one or more, but `rcTag` pins a *different* `vX.Y.Z-rc.*` | **fail** — ambiguous credential |
| GA, and the checkout sees no tags at all | — | **fail** closed (a tagless checkout cannot answer the question) |

Every outcome is written to the job's step summary and annotated (`::notice::`/`::error::`), so a
green `ga-tarball-diff` check that compared nothing is never mistaken for "compared and clean".

**Ordering for a credentialed GA.** Closing the credential window (clearing `rcTag`) before or after
merging the GA Version PR makes no difference to this gate — it keys on the tags. What matters: the
last rc you cut for `X.Y.Z` is the one that was credentialed. If you cut a later `vX.Y.Z-rc.N` tag
after the credential, either credential it or remove it before the GA cut; otherwise the diff runs
against the later, uncredentialed candidate (and, if `rcTag` still pins the earlier one, the gate
fails as ambiguous).

The comparison packs with **`npm pack`**, matching the real publish tool (`changeset publish`
shells to `npm publish` for a bun workspace) — never `bun pm pack`, which was measured (rehearsal,
#1562) to emit `@getknext/core`'s `dist/cli/kn-next.js` as a duplicate tar entry (its `bin` field
maps two command names, `knext` and `kn-next`, to that one file) and would have made this gate
permanently, incorrectly red on every real GA cut.

### Pack once, not three times (#1614/#1616)

Before this, three places packed the `@getknext/*` fixed group from independent builds of the same
commit: `audit` (`bun pm pack`), `ga-tarball-diff` (its own worktree build + `npm pack` of HEAD), and
`release` itself (`verify-published-group.mjs --pre`, also its own `npm pack`). The bytes were
measured byte-identical, but "measured identical today" is not "provably the same artifact" — and
`audit`'s tool was measurably NOT the one the real publish uses.

The `pack` job now packs the fixed group **once**, with `npm pack`, and uploads the tarballs plus a
`manifest.json` (name/tarball/sha256 per member) as the `release-tarballs` artifact:

- `ga-tarball-diff` downloads it and diffs the ga/HEAD side against those tarballs
  (`ga-tarball-diff.mjs --ga-dir`) instead of building+packing HEAD a second time in a worktree.
- `release` downloads it and, after packing its own fresh tree for the pre-publish check, sha256-
  compares that fresh pack against the artifact's manifest (`verify-published-group.mjs --pre
  --compare-dir`) and refuses to publish on any drift.

**`audit` is deliberately NOT wired to the shared artifact.** Its `bun pm pack` step exists for a
different reason than tool parity: bun rewrites a package's `workspace:^` sibling range from
`bun.lock`'s recorded version rather than from the manifest, and `siblingRangeProblems`
(`audit-published.mjs`) uses exactly that divergence to catch a stale lock (`bun install` never run
after a version bump) — the `pack` job's `npm pack` artifact (rewritten from the manifest, always
fresh) cannot reproduce that check. `audit` instead packs a **second** time with `npm pack`, from
the build it already runs, and audits/SBOMs those bytes — a small, local, non-blocking duplication,
kept out of the shared artifact's blast radius on purpose. What changed for `audit` is which bytes
get audited (`npm pack`'s, matching what ships), not which tool detects a stale lock (still
`bun pm pack`'s).

**Still a deliberate gap, not an oversight:** `release`'s actual publish step (`changesets/action`
running `changeset publish`) still packs from its own directory — `npm publish` for a bun workspace
shells out per-package from the checked-out tree, never from a pre-built tarball file — so the
literal bytes uploaded to npm are not (and cannot easily be, without forking that mechanism) the
`pack` job's tarball files themselves. The drift check above is the mitigation: it proves the
about-to-publish bytes are byte-identical to the audited/diffed ones, rather than literally
forwarding them.

### PR-time: published bytes stay frozen for the whole life of a credential window

The GA-vs-rc gate above catches a mismatch at the GA cut — 14 nights after the mismatch was actually
introduced. `.github/workflows/published-bytes-freeze-guard.yml` catches it at PR time instead:
while `.github/compat-credential-ref.json`'s `rcTag` is set, every PR that touches a path able to
reach a published package (`scripts/lib/published-bytes-freeze-check.mjs`'s
`publishScopeDirs` — derived from the same publishable-workspace-package list the GA-vs-rc gate
uses, plus a small, documented set of root build-input files: `package.json`, `bun.lock`,
`.changeset/config.json`, `scripts/rewrite-workspace-ranges.mjs`) is packed at its own merge ref and
diffed against the pinned rc tag's tarballs, using the **exact same comparison rules**
(`scripts/ga-tarball-diff.mjs`, reused as-is). A PR that touches none of that scope — the common
case — exits in milliseconds, before anything is packed.

The "is a window open" question is answered from the pin **as of this PR's base commit**, never its
head — mirroring `compat-credential-freeze-guard.yml`'s own rule for `rcTag`/`rcBumpMarker` — so a
PR cannot skip the check by clearing `rcTag` in the same diff that also changes published bytes; the
window was still open at base, so the check still runs.

An **intentional** rc.N+1 — real content is expected to differ from the currently-pinned rc — is
authorized the same way `rcBumpMarker` authorizes touching the credential harness mid-window: add a
dated, reviewed `publishedBytesBumpMarker: { date, expires, reason }` to the pin file in the same
PR (capped at 14 days from today, same rule as `rcBumpMarker`), and it is honoured only when THIS PR
introduces it, not when it is inherited from a marker already on `main`. The check then skips itself
for that PR; once the real content lands and a new `vX.Y.Z-rc.N+1` tag is cut and pinned, later PRs
are diffed against the new baseline.

This check fails closed — never silently skips — when the pinned `rcTag` does not resolve to a real
git tag in the checkout, and it is not yet a required check (same status as the sibling
`compat-credential-freeze-guard.yml`; flipping that is a branch-protection change a founder makes).

Dependabot is paused for the same window by a companion workflow
(`.github/workflows/dependabot-published-bytes-pause.yml`): any `dependabot[bot]` PR whose content
would be disallowed by the check above (a dependency bump touching a published package's manifest
during an open, un-overridden window) is auto-closed with an explanatory comment, using the exact
same scope/override decision. `.github/dependabot.yml` has no `npm`/`bun` ecosystem entry today (only
`github-actions`), so this is a no-op in practice until one is added — and correct from the day one
is, with no further edit needed. This workflow triggers on `pull_request_target`, not plain
`pull_request` — GitHub forces `GITHUB_TOKEN` to read-only for a `dependabot[bot]`-authored
`pull_request` event regardless of the workflow's own `permissions:` block, which would make `gh pr
close` fail every time. It never checks out or executes the PR's own head content: the changed-file
list comes from the GitHub API, and the PR's pin-file content is read as a git blob, never a
checkout.

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

### The "Changeset required" PR check

A PR that changes a published package's shipped surface — `packages/kn-next/src/**`,
`packages/kn-next/templates/**`, `packages/lib/src/**`, `packages/db/src/**`, the
`packages/kn-next-alias/bin/**` forwarding shim, or any of those packages' `package.json`
`bin`/`exports`/`files`/`dependencies`/`peerDependencies`/`optionalDependencies` — must carry a
`.changeset/*.md` naming the affected package. The `Changeset required` check
(`scripts/check-changeset-required.mjs`, `.github/workflows/changeset-required.yml`) flags a PR
that touches that surface with neither a changeset nor an explicit opt-out.

- **Tests-only, `__tests__`, and docs-only changes never trigger it** — only the shipped surface
  itself.
- **"Naming the affected package" is enforced, not just documented.** The check parses each
  added or modified `.changeset/*.md`'s YAML frontmatter (the `"pkg-name": patch|minor|major`
  block) and requires it to name at least one package this diff actually touches. A changeset
  naming only an unrelated or `ignore`d package (e.g. `@getknext/ui`), a PR that only *deletes* a
  stale changeset while touching real source, or a changeset with malformed frontmatter, does
  **not** satisfy the check — it fails closed the same way the rest of this checker does. A
  changeset naming two packages, one of them the touched one, does satisfy it.
- **A dependency bump counts as touching the package, even with no source edit.** A
  `dependencies`/`peerDependencies`/`optionalDependencies` change in a shipped package's
  `package.json` changes what every consumer installs, so it requires a changeset the same as a
  `bin`/`exports`/`files` change does. This is deliberately **broader** than
  `publicSurfaceChanged` (the predicate `check-escalation-triggers.mjs` uses to decide whether a
  *design gate* is needed) — the two checks answer different questions and are not required to
  agree. `devDependencies` and `scripts` changes stay quiet (build/test tooling, invisible to a
  consumer).
- **Opt-out:** label the PR `no-changeset` and say why in the PR description in one line. The
  label is mechanically checked; the reason is a review convention (the spec reviewer's job), the
  same way the docs-delta claim in `.claude/rules/workflow.md` step 5 is verified by a human, not
  parsed.
- **This is a PR-time nudge, not a release-lane gate** — the release lane above already has its
  own coherent-group checks (`version-pr`, `publish-preflight`). This closes the earlier, cheaper
  catch point: three PRs (#1569, #1588, #1575) changed published-package behaviour and merged with
  no changeset, so none showed up in `packages/kn-next/CHANGELOG.md` or the rc.1 release notes
  until a later PR hand-backfilled them.
- **Pre-release caution:** once `.changeset/pre.json` exists (changesets **"pre" mode**, entered
  ahead of an `rc.N`), adding a new changeset here versions the **next prerelease** (e.g. `rc.2`),
  not a stable release. That is still the correct outcome — an `rc` that ships a behaviour change
  with no changelog entry is exactly the gap this check exists to close.

## GA-cut runbook (rc → 1.0.0)

This is the exact sequence from "the credential window closed 14/14 green on all four cells" to
"`1.0.0` is on npm `latest`". It assumes the credential window's own gate (14 consecutive nightly
green runs on the pinned rc, across every credentialed runtime/builder combination) has already
closed successfully — this section does not re-derive that gate, only what happens after it.

Steps marked **[FOUNDER]** are not agent-doable: they require a click a human must make (an
environment approval, a `git push` of a release tag, or a branch-protection setting) or a decision
about whether to proceed that should not be automated.

### GA preconditions

Confirm every box before starting step 1 below:

- [ ] 14/14 credentialed nights, all four runtime × builder cells, on the currently pinned `rcTag`.
- [ ] The GA-vs-rc tarball diff (`ga-tarball-diff-gate.mjs`) is green — version-only — as a
      **pre-flight dry run** against the pinned rc, not first discovered mid-step-4 on the Version
      PR itself.
- [ ] Platform/operator e2e is green **at the rc tag**, with the operator built from that tag and
      its image digest recorded (#1305).
- [ ] The docs launch pass is live on knext-platform.dev (quickstart, compatibility table, and version
      numbers all reflect the rc under credential — not a stale prior release).
- [ ] The operator tag-release line (`operator-vX.Y.Z`, semver GitHub Releases from a pushed tag,
      #1667) has merged — it has, as of this writing; step 7 below's rolling-`operator-latest`
      fallback is only a last resort if the `operator-v1.0.0` tag push is skipped.
- [ ] The rollback rehearsal on the `rc` npm dist-tag (see [Rollback runbook](#rollback-runbook-100-ships-broken)
      below) has been run and its result recorded, so the rollback path is proven reachable
      *before* it is ever needed for real.
- [ ] **[FOUNDER]** #1638 (`npm-publish` environment required reviewer + `v*` tag protection) and
      #1373 (credential freeze guard / published-bytes guard CODEOWNERS + required review) are
      both made **required checks** — see [The gate](#the-gate-two-lanes-one-approval) above for
      why the `npm-publish` environment carries no reviewer today without #1638.

1. **Confirm the credential window is closed.** Every one of the four runtime × builder
   combinations shows 14/14 green in the compat ledger for the pinned `rcTag`. If any cell is short,
   stop — do not cut GA on a partial window.
2. **Clear `rcTag`.** Open a PR that removes the pin from `.github/compat-credential-ref.json`. This
   is the same pin PR shape the window-open step used in reverse. Merging it closes the credential
   window and, from this PR's merge base onward, releases the PR-time published-bytes freeze guard
   (`published-bytes-freeze-guard.yml`) and the Dependabot pause — published-package PRs can move
   again once GA is actually cut.
3. **Changeset `pre exit`.** Run `bunx changeset pre exit` and commit the result. This takes the
   four `@getknext/*` fixed-group packages out of changesets' prerelease ("pre") mode, so the next
   Version PR proposes a stable version rather than another `rc.N`. Open this as its own PR.
4. **Prepare and hand-open the "Version Packages" PR → `1.0.0`.** `getknext-dev`'s org setting
   ("Actions can create or approve pull requests") is **off**, so `version-pr`'s bot-driven PR-open
   step is always refused (`release.yml`'s own step prints `GitHub Actions is not permitted to
   create or approve pull requests` and tells you to open the PR by hand — this is not new for GA,
   it is the standing state of every Version PR on this repo). Do **not** wait for a bot-opened PR
   to appear. Use the same hand-prepared recipe already used twice for the rc.1 and rc.2 "prepare"
   PRs (rc.1: #1591; rc.2 #1659, "same recipe as rc.1"):

   ```sh
   git switch -c release/1.0.0 main
   bunx changeset version        # consumes every pending changeset, bumps the fixed
                                  # group to 1.0.0 (pre.json is already gone from step 3)
   git add -A
   git commit -m "release: version packages"
   git push -u origin release/1.0.0
   gh pr create --base main --title "chore: version packages" \
     --body "Prepares 1.0.0 on the fixed group (@getknext/core, @getknext/lib, @getknext/db, kn-next)."
   ```

   Verify the PR proposes `1.0.0` for all four fixed-group members before merging — a `pre exit`
   that landed out of order, or a changeset still describing a `rc.N+1`-shaped bump, would show up
   here as the wrong target version. **CI must be fully green on this PR before merging, especially
   the GA-vs-rc tarball diff (versions only).** `ga-tarball-diff-gate.mjs` runs automatically on
   this PR's `release.yml` invocation once it detects a stable target version with a matching
   `vX.Y.Z-rc.N` tag in history (see [A credentialed GA must differ from its last rc ONLY in version
   fields](#a-credentialed-ga-must-differ-from-its-last-rc-only-in-version-fields) above) — do not
   merge if that check is red; a red diff means the tarball about to publish is not the one the 14
   nights actually credentialed.
5. **[FOUNDER] Approve the `npm-publish` environment deployment.** Merging the Version PR is a
   second push to `main`; `release` starts and parks in `waiting` for the environment's
   required-reviewer approval (see [Subsequent releases](#subsequent-releases) step 4). Check the
   run's head SHA before approving — it must be the Version PR's merge commit, not a stale parked
   run. `changeset publish` then ships `1.0.0` to all four packages on the `latest` dist-tag.
6. **[FOUNDER] Push the `v1.0.0` tag.** `git tag v1.0.0 <merge-commit-sha> && git push origin
   v1.0.0`. Verify it landed with `git ls-remote --tags origin v1.0.0` before moving on — a tag
   that silently failed to push leaves every step below pointed at nothing.
7. **Operator release.** The operator's tag-triggered `operator-vX.Y.Z` release line (#1667,
   **merged**) is the standing mechanism: `operator-supply-chain.yml` builds, SBOMs, Trivy-gates,
   cosign-signs, and publishes an immutable, digest-pinned GitHub Release from any pushed
   `operator-vX.Y.Z[-rc.N]` tag, and **only a stable (non-prerelease) tag** also re-points the
   rolling `operator-latest` channel — a plain push to `main` moves only the rolling
   `operator-edge` channel, never `operator-latest`. Cut it:
   ```sh
   git tag operator-v1.0.0 <operator-main-sha-to-ship> && git push origin operator-v1.0.0
   ```
   Then confirm the resulting `operator-v1.0.0` release exists, its `install.yaml` resolves to a
   real signed image digest, and `operator-latest` now points at the same digest.
   **Fallback, only if this tag push is skipped for some reason:** `operator-latest` keeps
   republishing on every push to `main` regardless, so GA could ship against that rolling channel
   instead — but then record which operator commit SHA / image digest it carries in the GA release
   notes (there is no separate `v1.0.0`-tagged operator artifact in that case — `operator-latest`
   IS the artifact), and do not hand-apply an unsigned or untagged image either way. The tagged
   path above is preferred and should be the default.
8. **Stranger install + upgrade verification against the live registry.** From a clean environment
   with no local checkout state: `npm exec --package=@getknext/core@latest -- kn-next create` (the
   documented quickstart) must scaffold and `npx kn-next --help` must exit 0. Separately, on a
   cluster running the previous stable operator/CRD, apply the new `operator-v1.0.0` `install.yaml`
   and confirm an existing `NextApp` reconciles cleanly — the [Upgrade order](#upgrade-order)
   section's "operator/CRD first, then CLI" rule applies to this step itself.
9. **Docs deploy.** Redeploy the docs site through the normal platform path so the published
   version numbers, compatibility table, and quickstart on the live site match what `npm view` now
   reports. A GA cut with stale docs is not "done" — see `.claude/rules/workflow.md` step 5's docs
   requirement, which applies to this cut like any other user-visible change.
10. **Announce.** Publish the announcement once steps 1–9 are all confirmed, not before — an
    announcement pointing at a still-parked publish or a stale docs deploy sends strangers to a
    broken front door on day one.

### If a night reds between 14/14 and the cut

**Do not re-run the reset night.** The credential is 14 *consecutive* green nights on the *same*
pinned rc tarball; a red night after the window nominally closed but before GA is actually cut means
the window is no longer 14/14 as of now — treat it exactly as a mid-window reset (see the VOID-night
rule in the compat ledger for the one narrow exception: a night that failed before any knext code ran
at all, proven by a knext-owned marker). **The window restarts from the next green night**, not from
night 1's original calendar date and not from a manually-edited count. If the red points at a real
defect in the pinned rc's tarball, fix forward on a new `rc.N+1` (a new prerelease is expected to
differ from the last one — the freeze guard's `publishedBytesBumpMarker` override exists for exactly
this) rather than patching the already-credentialed tag in place; the credential must always describe
a `git tag`'s actual, unmodified bytes.

## Rollback runbook (1.0.0 ships broken)

If `1.0.0` reaches `latest` and turns out to be broken, this is the exact recovery. Read it before
you need it — the middle of an incident is the wrong time to be deriving "does moving a dist-tag
unpublish the version" from first principles.

**The rule that governs every step below: never unpublish.** `npm unpublish` removes the version
from the registry entirely, which breaks every consumer who has already installed or pinned it (npm
disallows unpublishing a version more than 72 hours old for exactly this reason, but even inside
that window it is the wrong tool here) — it does not undo the fact that people already ran the code.
Recovery here means *redirecting new installs away from the broken version*, not erasing it.

1. **Move `latest` back to `0.4.3` on all four publishable packages together** — `@getknext/core`,
   `@getknext/lib`, `@getknext/db`, and `kn-next`. They are Changesets' `fixed` group and always ship
   (and now roll back) as a set; moving three of the four and forgetting the fourth reproduces the
   exact #255/#256 partial-group incident, just via a dist-tag move instead of a publish. Use
   `scripts/npm-dist-tag-rollback.mjs` for this — see below.
2. **`npm deprecate 1.0.0` with a pointer.** Once the tag is moved, deprecate the broken version on
   each of the four packages with a message naming the safe version — `npm-dist-tag-rollback.mjs`
   emits this command in the same run as step 1.
3. **Roll back the operator image, never the CRD.** Re-point the operator Deployment at the previous
   stable image digest (`operator-v0.4.x`'s pinned digest). Do **not** roll back the CRD: per
   [Upgrade order](#upgrade-order), a CRD only ever moves forward (additive-only), and rolling it
   back risks stripping a field an already-reconciled `NextApp` still carries, which is a worse
   failure than leaving the newer, backward-compatible schema in place under the older operator
   binary.
4. **Revert the docs deploy.** Redeploy the previous docs-site build so the live compatibility table
   and quickstart stop claiming `1.0.0` is current.
5. **Fix forward as `1.0.1`.** Patch the actual defect and release it normally. `1.0.1` is not
   credentialed by the 14-night rc process — the GA-vs-rc diff gate is designed to skip a GA version
   with no matching `rc.N` tag (see the table in [A credentialed GA must differ from its last rc
   ONLY in version fields](#a-credentialed-ga-must-differ-from-its-last-rc-only-in-version-fields))
   — and that is the correct, honest behaviour: a hotfix does not get to borrow the previous rc's
   credential.

### `scripts/npm-dist-tag-rollback.mjs`

Computes and prints the exact `npm dist-tag add` / `npm deprecate` commands for steps 1–2 above, for
all four publishable packages at once. **Defaults to a dry run** — it only touches the registry with
the explicit `--execute` flag:

```sh
# Print the plan (default — no registry writes):
node scripts/npm-dist-tag-rollback.mjs --to 0.4.3 --broken 1.0.0

# Actually run it (requires npm auth in the environment):
node scripts/npm-dist-tag-rollback.mjs --to 0.4.3 --broken 1.0.0 --execute
```

It refuses before touching anything — exits 1 with no writes — if the rollback target is not
published for all four packages (a typo'd or never-released target would otherwise point `latest`
at nothing), or if the discovered publishable-package count is not exactly four (a workspace change
the script does not yet know about). It is unit-tested against a stubbed `npm` on `PATH`
(`tests/npm-dist-tag-rollback.test.ts`) — no network involved in that suite.

### **[FOUNDER] Rehearsal on the `rc` dist-tag**

The dist-tag-move and `npm deprecate` steps above are rehearsed on the **`rc`** dist-tag before ever
being needed on `latest` — the same script, pointed at the non-production tag, so a mistake in the
rehearsal cannot touch real users:

```sh
node scripts/npm-dist-tag-rollback.mjs --to 0.4.3 --broken 1.0.0-rc.2 --dist-tag rc --execute
```

This requires npm publish credentials against the real `@getknext/*` registry entries, so it is a
**founder action**, not something an agent runs. Record the result (the commands the script printed,
their outcome, and `npm view @getknext/core dist-tags.rc` / `npm view @getknext/core
versions.1.0.0-rc.2.deprecated` confirming the rehearsal actually landed) on the tracking issue.

### Rehearsal evidence (#1673, 2026-10-02) — read-only half, agent-run

The `--execute` step above is founder-only (it writes to the real registry). Everything that does
**not** require npm publish credentials was rehearsed for real against the live `@getknext/*`
registry entries, with `rcTag` pinned at `v1.0.0-rc.5`:

1. **Dist-tag state read, all four packages:**
   ```sh
   npm view @getknext/core dist-tags   # { latest: '0.4.3', rc: '1.0.0-rc.5' }
   npm view @getknext/lib dist-tags    # { latest: '0.4.3', rc: '1.0.0-rc.5' }
   npm view @getknext/db dist-tags     # { latest: '0.4.3', rc: '1.0.0-rc.5' }
   npm view kn-next dist-tags          # { latest: '0.4.3', rc: '1.0.0-rc.5' }
   ```
2. **Rollback plan dry run** (default mode — no `--execute`, so this only reads the registry via
   `npm view` to confirm the rollback target is published for all four packages, then prints the
   plan; it writes nothing):
   ```sh
   node scripts/npm-dist-tag-rollback.mjs --to 1.0.0-rc.4 --broken 1.0.0-rc.5 --dist-tag rc
   ```
   Printed the correct 8-command plan (4× `npm dist-tag add … rc`, 4× `npm deprecate`) after
   confirming `1.0.0-rc.4` is published for all four packages — the "refuse if target isn't fully
   published" guard was exercised on a real, valid target.
3. **Previous-version install verification:** in a scratch directory, `npm install
   @getknext/core@1.0.0-rc.4 --no-save` succeeded (203 packages), and the installed binary ran
   (`kn-next --help` printed the deprecation notice for the `kn-next` alias and the usage banner) —
   confirming a prior rc actually installs and runs, which is what "move `latest`/`rc` back" is
   buying.

**Not rehearsed by an agent, per the task rules:** moving the `rc` dist-tag itself
(`--execute`) and `npm deprecate` are registry writes and remain **[FOUNDER]**-only, as documented
above.

## Patch release runbook (1.0.1)

`1.0.0` ships from the `1.0.0-rc.5` bytes with two known issues documented in
`docs/release/v1.0.0.md` rather than held for a re-credentialed rc cycle (see [Rollback runbook](#rollback-runbook-100-ships-broken)'s
note that a hotfix does not borrow the previous rc's credential — the same reasoning applies to a
planned patch, not just an incident). `1.0.1` closes both, fixed on `integration/v1.3` ahead of GA.
After GA:

1. Cut a `release/1.0` line from the `1.0.0` tag if one does not already exist.
2. Cherry-pick the #1843 fix (Node-runtime Redis client missing from the standalone output's
   `node_modules`) from `integration/v1.3` onto `release/1.0`.
3. Cherry-pick the #1834 fix (the scaffold template issue behind the `containerConcurrency: 100`
   known issue) from `integration/v1.3` onto `release/1.0`.
4. Run the normal release gate (`pack`, `audit`, the GA-tarball-diff check does not apply here —
   `1.0.1` has no matching rc tag, which is expected per the diff gate's own skip condition) against
   `release/1.0`, then publish `1.0.1` through the usual Changesets flow.
5. Update `docs/release/v1.0.0.md`'s "Known issues" entries to say they are fixed in `1.0.1`
   (already worded that way as of this writing — just confirm before publishing), and drop the
   matching callouts from the affected `apps/docs` pages once `1.0.1` is the published `latest`.

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

### The same ordering applies to scale-zero-pg's failover controller

The scale-to-zero database (`packages/scale-zero-pg`) ships its own read-authority watcher
(`pswatcher`, `deploy/58-pswatcher.yaml`), and it obeys the same "reader upgrades before the
manifest that writes its contract" rule the operator-then-CLI order above encodes. When a
scale-zero-pg upgrade adds or changes a `pswatcher` env var — the routed-tenant set
(`PSW_APPS_TENANT_ID`), the maintenance-freeze ConfigMap name (`PSW_FREEZE_CONFIGMAP`), the freeze
hard-TTL bound (`PSW_MAX_FREEZE_MS`), the routed pageserver management URL (`PSW_ROUTED_BASE_URL`),
or any other new `PSW_*` flag — **roll the `pswatcher` image to the new digest first, then apply the
manifests that wire the new env.** Applying a new env var against an older binary makes it inert: the
running watcher does not read a variable it was not built to know, so the setting silently does
nothing — the same failure mode as a CLI running ahead of the CRD. The operational detail lives in
the package runbook, `packages/scale-zero-pg/docs/operations.md` § "Upgrades".

## Retired: interim GitHub Packages channel (`@getknext-dev/*`)

**(#1644)** `release-ghp.yml` — the manual-only interim publish channel to
`npm.pkg.github.com` under the `@getknext-dev/*` scope — is **deleted**. It was
introduced while the npmjs path (`@getknext/*`, `release.yml`) was believed to be
blocked on auth (issue #53); that premise stopped being true on 2026-07-25 (see
[The gate](#the-gate-two-lanes-one-approval)), and the workflow carried none of
`release.yml`'s gates (no GA-vs-rc tarball diff, no publish preflight, no group
verification, no environment). **`@getknext/*` on npmjs is the only publish
path.** A scan test (`tests/single-publish-workflow.test.ts`) enforces that no
workflow other than `release.yml` runs `npm publish` / `changeset publish` /
`bun publish`.

If GitHub Packages publishing is ever needed again, it must be added as a
gated job inside `release.yml`, not as a second standalone workflow.
`scripts/rename-for-ghp.mjs` (the `@getknext/*` → `@getknext-dev/*` staging
rewrite the old workflow used) is kept — it is still unit-tested
(`tests/rename-for-ghp.test.ts`) and reused by the npm-scope contract test
(`tests/npm-scope-getknext.test.ts`) — but nothing currently invokes it as a
publish step. `scripts/ghp-install-smoke.mjs`, which existed only to
consumer-smoke-test the retired channel, is deleted along with it.

Existing `@getknext-dev/*` packages already published to GitHub Packages are
untouched by this — this only stops publishing *new* versions there.

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
