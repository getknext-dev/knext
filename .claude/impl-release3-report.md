# Report — the release lane's second breakage: `changesets/action` v2 requires Changesets CLI v3

Branch `fix/changesets-cli-v3` · PR **#851** · worktree `/Users/banna/alpheya/pocs/knext-wt/release3`

---

## 1. What was actually wrong

Run [`32850202919`](https://github.com/getknext-dev/knext/actions/runs/32850202919), job
**"Version PR (no credential, no approval)"** → `failure`:

```
##[error]Error: This version of the Changesets action is designed to work with Changesets CLI v3.
Changesets CLI v2 is not supported; use Changesets action v1 instead, which is compatible with CLI v2.
```

Read at the pinned SHA (`changesets/action@198f833`, `src/index.ts`): `validateChangesetsCliVersion(cwd)`
is the **first** statement in the action, before `throwOnRenamedInputs`, before the token check,
before `readChangesetState`. So the job dies before `core.setOutput('has-changesets', …)` ever runs.
That is why the other three jobs in the run were **skipped, not failed** — `has_changesets` resolved
to `''`, which satisfies neither `== 'false'` nor `== 'true'`. The board showed one red job and
three greys, and nothing anywhere said "the release lane is dead".

The check has two halves (`src/utils.ts`): it throws if the **root manifest's** `@changesets/cli`
range is a subset of `>=2.0.0-0 <3.0.0-0`, **and** separately if the **resolved**
`@changesets/cli/package.json` on disk has major 2. Both matter — see §5.

## 2. The two open PRs, checked first

Neither is the intended fix. **Neither touches `@changesets/cli` at all.**

- **#749** ("take the changesets/action v2 bump with its input migration"). **Fully superseded on
  `main` — both halves.** Its `release.yml` half landed via the follow-up to #831, not by merging
  #749; `release.yml:165` says so in its own comment: *"#831 took the v1->v2 pin bump WITHOUT this
  migration (#749 had it, but was not what merged) … migration mirrors #749."* Its other half —
  `helm/kind-action` v1.12.0 → v1.14.0 — is **also** already on `main`
  (`networkpolicy-enforcement.yml:50` is `helm/kind-action@ef37e7f… # v1.14.0`, the exact pin #749
  proposes). So #749 is a no-op against `main` in its entirety.
  **Recommendation (maintainer's call, not taken here): close #749.** Nothing needs re-cutting.
- **#839** (Dependabot, `changesets/action` 2.1.0 → 2.1.1, currently `CONFLICTING`). Compatible with
  this change and **not** superseded — 2.1.1 is still major 2, so it still requires CLI v3, and after
  this lands the new guard covers it. Its conflict is Dependabot's to rebase.

This PR does not conflict with either: it touches `package.json`, `pnpm-lock.yaml`,
`.changeset/config.json`, one workflow **comment block**, one new test, and the prover.

## 3. The remedy: **(a) upgrade `@changesets/cli` to v3**

Not (b) pin the action back to v1.

**Why (a).**

1. **(b) is not a pin change, it is a three-part revert.** `changesets/action@v1` takes the *old*
   input names (`version`, `publish`, `commit`, `title`, `createGithubReleases`), does not take
   `github-token` as an input, and pushes with the git CLI. Reverting means undoing the input
   migration that this repo has already got wrong once — #831 took the bump *without* it, and #750
   exists precisely because GitHub **ignores** unknown `with:` keys instead of failing, so the step
   sat green while running with every input defaulted. Re-opening that surface to avoid a dependency
   bump is the wrong trade.
2. **(b) does not hold.** `security.md` makes Dependabot the owner of these pins so that pinning
   does not decay into staleness — and **#839 is open right now**. Pinning back to v1 leaves the repo
   one accepted Dependabot PR away from the identical outage, with nothing able to see it. The
   *forward* direction has an equivalent hazard (a future action v3), which is why the remedy is not
   complete without §5.
3. **The forward path is cheap, and I measured that rather than assuming it.** v3's new `engines`
   (`node ^22.11 || ^24 || >=26`, `pnpm >=10.0.0`, `npm >=10.9.0`) are already satisfied: every
   release job pins `node-version: '24'` and the repo declares `packageManager: pnpm@10.4.1`. Every
   config key this repo uses survives into `@changesets/config@4` — `fixed`, `linked`, `access`,
   `updateInternalDependencies`, `ignore`, `changelog`, `commit`, `baseBranch` (checked against the
   published v4 schema, not from memory). Nothing in the repo touches a removed surface: no
   `changeset tag` (renamed to `git-tag`), no `--sinceMaster`, no `prettier:` config key, no
   `___experimentalUnsafeOptions…useCalculatedVersionForSnapshots`.

**What is being traded — the honest list.** v3 is a major and three of its changes are real:

| v3 breaking change | What it does here |
|---|---|
| `changeset version` exits **1** with no unreleased changesets (#1860) | **Not reached through the action** — `src/index.ts` calls `runVersion` only in the `hasChangesets` branch. It *does* mean a human running `pnpm changeset:version` on a clean tree now gets a non-zero exit where they used to get a silent 0. |
| Private packages no longer versioned by default (#2186) | **Measured, not assumed** (§4): `knext-docs` and `db-demo` stop receiving cosmetic patch bumps. Neither is published; `.changeset/config.json` already ignores the other three private packages. |
| Published as ESM (#1482) | Nothing in this repo imports `@changesets/cli`. Both subpaths the lane depends on still exist in 3.0.1's `exports`: `./bin.js` (which the action `require.resolve`s) and `./changelog` (which `.changeset/config.json` names). |
| `prettier` config option removed → `format` (#1994) | No-op. The repo carries no `prettier` key and no formatter config at all, so `format: "auto"` detects nothing — same effective behaviour as today (prettier is not installed). |

**Residual risk of (a), stated rather than suppressed.** v3 landed 22 major changes; I read all of
them and traced the ones above, but "I read the changelog" is a weaker claim than "I ran it". §4 is
what upgrades it from reading to running, and §6 is the end-to-end proof.

## 4. Verified by RUNNING (as opposed to by reading)

On a copy of this tree (rsync'd, `node_modules` symlinked, own git init so `changeset` can diff):

**CLI 3.0.1**

```
changeset version   → exit 0
@getknext/core  0.3.0 → 0.3.1
@getknext/lib   0.3.0 → 0.3.1
@getknext/db    0.3.0 → 0.3.1
kn-next         0.3.0 → 0.3.1     ← the `fixed` group's fourth member, from changesets that
                                     name only the other three
knext-docs      0.1.1  (unchanged)
db-demo         0.1.2  (unchanged)
```

Internal ranges preserved as `workspace:^` in both `@getknext/core` and the `kn-next` alias.
Changelogs written for all four (`packages/kn-next-alias/CHANGELOG.md` created), both pending
changeset files consumed.

**CLI 2.31.0, same tree, for comparison**

```
@getknext/{core,lib,db}, kn-next  → 0.3.1   (identical)
knext-docs   0.1.1 → 0.1.2                  (v3 does not do this)
db-demo      0.1.2 → 0.1.3                  (v3 does not do this)
```

So the publishable result is **byte-identical between the majors**, and the only delta is two
private, never-published apps losing a cosmetic bump.

**Also run:** `scripts/mutation-prove-release-lane.mjs` → **22/22 red**, `{"declared":22,"run":22}`,
tree restored byte-identically, `scripts/scan-mutation-residue.mjs` clean, `git status --porcelain`
empty. Plus `vitest run` over the four release-lane specs (59 tests), `tsc -p tsconfig.typecheck.json`
(exit 0), `biome check .` (exit 0).

**Verified by READING, and flagged as such:** the action's own source at the pinned SHA — that
`validateChangesetsCliVersion` precedes everything, that `version-script` runs only on
`hasChangesets`, that `resolveChangesetsCli` resolves `@changesets/cli/bin.js`, and the
`@changesets/config@4` schema's key set.

## 5. The guard — because a green suite proved nothing here

`tests/changesets-cli-action-compat.test.ts` (new).

Nothing in the repo could see this failure class. `tests/release-action-pins.test.ts` asserts a
pin's **form and scope** — 40-hex SHA, auditable `# vX.Y.Z` comment, allowlisted action, which job
holds the credential — and **every one of those held**. `tests/release-lane-liveness.test.ts` asserts
the lane's **shape** — jobs, `needs` edges, concurrency groups, output key names — and every one of
those held too. The mismatch is a relation *between* the workflow and the root manifest, and it is
only reachable on a push to `main`, which no PR's CI can exercise. It sat there for a month behind a
deadlock that was itself hiding it.

Asserted, fail-closed:

- the action major and the CLI major are a **recorded compatible pair** (v1↔v2, v2↔v3), **both
  directions** — bumping either side alone reds;
- an **unrecorded** action major (a future v3) reds and demands a deliberate decision rather than
  passing silently. The last bump passed silently; that is the whole point;
- every `changesets/action` step in `release.yml` runs the **same** major;
- `pnpm-lock.yaml`'s **root-importer resolution** matches the declared major. CI installs
  `--frozen-lockfile` and the action `require.resolve`s the installed package *as well as* reading
  the declared range, so a manifest-only assertion would go green while the live run still failed;
- the `with:` input **names** match the pinned major — the #750 class, folded into the same spec
  because it is the same bump, and because `validateChangesetsCliVersion` runs *before*
  `throwOnRenamedInputs`: fixing only one of the two leaves the lane broken with a different error.

The range parser is deliberately **strict** (`^X.Y.Z` only) and treats anything else as a
**failure, not a skip** — "unparseable therefore fine" is how a guard passes vacuously.

Deliberately **not** asserted: SHA↔tag resolution. That stays with the nightly
`scripts/verify-action-pins.mjs`, per the division of labour in `security.md` — form and scope at PR
time, resolution at run time. Baking resolved SHAs into a committed assertion is what reddened every
correct Dependabot bump last time and trained the reader to edit the guard to get green.

**Mutation-proved independently**, mutations 19–22 of `scripts/mutation-prove-release-lane.mjs`,
each graded against the new spec **alone**:

| # | Defect restored | Result |
|---|---|---|
| 19 | the `@changesets/cli` major goes back to 2 — *literally what `main` shipped* | RED |
| 20 | the version-pr pin claims v1 while the CLI stays v3 (the drift, seen from the other file) | RED |
| 21 | manifest bumped, **lockfile not** | RED |
| 22 | the v1 input name `version` returns under a v2 action | RED |

The harness proves it can see red first: the prover asserts all four baseline specs GREEN before
mutating, requires RED under each mutation, and re-asserts GREEN after each byte-identical restore.
Branching is on **exit codes** (`spawnSync(...).status === 0`), never on output text.

Mutation **19 is the historical bug exactly** — the guard is proved against the real defect, not a
synthetic stand-in.

Anchors for 19–22 are **derived from the current file contents** rather than typed as literals.
Every value they address is one Dependabot moves; a hardcoded anchor would FATAL on the next
*correct* bump, and "the prover is broken again, edit the anchor" is how a prover decays into
something people route around. Not-found is a hard exit, never a skip.

`package.json` has no comment syntax, so mutation 19's replacement carries the residue marker itself
as a JSON-legal `"//…"` key — and the marker is **interpolated from `MUTATION_MARKER`, never typed**,
because `scan-mutation-residue.mjs` refuses any *tracked* file containing the literal and the prover
is tracked.

## 6. End-to-end verification

A green suite is not proof here — the previous breakage was invisible to every spec. So the Release
workflow was **dispatched on this branch** (`workflow_dispatch`, run
[`32852155878`](https://github.com/getknext-dev/knext/actions/runs/32852155878)), which is the only
way to exercise the Version-PR job before merge.

**Structurally safe by the lane's own gating, checked before dispatching:** with two changesets
pending, `has_changesets` resolves to `'true'`, so `publish-preflight` (`if … == 'false'`) and
`release` (which needs both `has_changesets == 'false'` and the preflight's output) are both
**skipped**. No credential is reached, no environment approval is requested, nothing publishes.

## 7. Outcome of the live run — the fix works, and it exposed a FOURTH blocker

Run [`32852155878`](https://github.com/getknext-dev/knext/actions/runs/32852155878):

```
audit                → success
version-pr           → FAILURE   (but not where it failed before — read on)
publish-preflight    → skipped   (as predicted: has_changesets == 'true')
release              → skipped   (as predicted: no credential reached, no approval requested)
```

**The CLI-v3 remedy is verified live.** The Version-PR job's log:

```
[command] .../pnpm run changeset:version
> changeset version
🦋 changeset v3.0.1
All files have been updated. Review them and commit at your leisure
Existing pull requests: []
creating pull request
##[error]HttpError: GitHub Actions is not permitted to create or approve pull requests.
```

The compatibility error is **gone**. `validateChangesetsCliVersion` passed, the v2 input names were
accepted, `changeset version` ran under CLI 3.0.1, and the action **pushed a real commit** —
`414d0f1`, authored `github-actions[bot]`, "chore: version packages" — carrying exactly the bump §4
predicted, produced on CI rather than on my machine:

```
@getknext/core 0.3.1   @getknext/lib 0.3.1   @getknext/db 0.3.1   kn-next 0.3.1
knext-docs 0.1.1 (untouched)   db-demo 0.1.2 (untouched)
+ packages/kn-next-alias/CHANGELOG.md   - both .changeset/*.md consumed
```

That branch was **deleted after inspection** (`changeset-release/fix/changesets-cli-v3`); the
pre-existing `changeset-release/main` was left alone — it is not mine (see below).

**The fourth blocker.** The job now dies one API call later, on a repository/organisation setting:

```
$ gh api repos/getknext-dev/knext/actions/permissions/workflow
{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
$ gh api orgs/getknext-dev/actions/permissions/workflow
{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
```

`can_approve_pull_request_reviews` is the API name for the UI toggle **"Allow GitHub Actions to
create and approve pull requests"** — it gates *creating*, not only approving. It is `false` at both
levels. The workflow's own `permissions: pull-requests: write` cannot override it.

**This blocker is OLDER than the other two, and it has never once been cleared.** Evidence, not
inference:

- `changeset-release/main` on the remote is `44fcdbc`, `github-actions[bot]`, **2026-07-25
  23:31:54Z**.
- The run that pushed it — [`30179506243`](https://github.com/getknext-dev/knext/actions/runs/30179506243),
  2026-07-25T23:29:47Z, under the **old** action v1 and **CLI v2** — failed at 23:31:56 with the
  *identical* message: `GitHub Actions is not permitted to create or approve pull requests`.
- The Version PR that actually shipped 0.3.0, **#523**, was opened by `AhmedElBanna80` on
  2026-07-26 from head branch **`agent/version-packages-debut`** — a hand-made branch, not the
  action's `changeset-release/main`. Same for #268.

So the action has **never** successfully opened a Version PR in this repository. Every one to date
was made by hand. The concurrency deadlock (#849) and the CLI mismatch (this PR) were each hiding
the one behind it; this is the last one in that stack, and it is the only one an agent cannot fix.

**Remedy — human-only, not taken here.** Either:

1. **Flip the toggle** (recommended). Settings → Actions → General → Workflow permissions → *Allow
   GitHub Actions to create and approve pull requests*. It is off at **org** level too, so the org
   setting must permit it first. Via API:
   `gh api -X PUT orgs/getknext-dev/actions/permissions/workflow -F can_approve_pull_request_reviews=true`
   then the same for `repos/getknext-dev/knext/...`. **Deliberately not run**: changing an
   organisation-wide Actions security setting is not an agent's call, and this task authorised
   landing a fix, not widening a permission boundary.
2. **Give the version-pr step a PAT or GitHub App token** instead of `GITHUB_TOKEN`. Works without
   the toggle, but it puts a **standing credential** on the lane whose entire design premise
   (`release.yml:127`) is that it holds none — which is what lets it run unapproved. That is a
   `security.md` decision, and I am not making it unilaterally.
3. **Keep opening the Version PR by hand**, which is the status quo and works: the action still
   pushes the correct `changeset-release/main` branch; only `gh pr create` against it is missing.

Option 3 means the lead is **not blocked today** — after this merges, the push to `main` will
produce a correct `changeset-release/main` branch and a PR can be opened from it by hand, exactly as
#523 was.

## 8. What remains — not done here, deliberately

- **No publish, no Version PR merged, no deployment approved.** The lead runs the publish sequence.
  Once this merges to `main`, the push triggers `release.yml`, the Version-PR job runs
  `changeset version` and pushes `changeset-release/main` — and, until §7's toggle is flipped, the
  PR against it must be opened by hand. Merging *that* is what makes the publish job reachable,
  behind the `npm-publish` environment's required reviewer.
- **The §7 permission toggle is not flipped.** Human-only; the exact commands are in §7.
- **`changeset-release/main` (`44fcdbc`, 2026-07-25) is left on the remote untouched.** It is stale
  — it versions against a month-old tree — but it is not this task's to delete, and deleting a
  branch someone may be about to use is not reversible. The next successful release run will
  force it forward on its own.
- **#749 should be closed.** Both of its halves are already on `main` (§2), so it is a no-op. Not
  done here: closing someone else's PR is not this task's call.
- **#839 needs a rebase** for its merge conflict (Dependabot's to do). It stays valid.
- **`pnpm@10.4.1` vs v3's `pnpm >=10.0.0`** is satisfied today with little headroom above the floor.
  Not raised here — a `packageManager` bump changes every job in every workflow and is its own change.
- **Not covered by any guard:** that the action's *behaviour* under CLI v3 matches v2 beyond the
  `changeset version` result measured in §4. The compat guard asserts the version **pairing**, which
  is the thing that broke; it is not a functional test of the action.
