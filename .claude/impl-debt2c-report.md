# Debt 2c — #750 input-existence check: implementation report

Branch `fix/pin-guard-inputs-exist` (worktree `/Users/banna/alpheya/pocs/knext-wt/pin-guard-inputs-exist`).

## What shipped

`scripts/verify-action-pins.mjs` (the #539/#640 nightly resolver) now ALSO verifies, for every
pin that passes `with:` keys, that each key is a **declared input** of the action **at the
pinned SHA** — closing the gap #750 demonstrated with the changesets/action v1→v2 bump
(GitHub silently ignores unknown `with:` keys, so a renamed input evaporates with every
guard green).

- **Extraction**: `parsePins` now attaches `withKeys` (each with its own line), the in-repo
  `subpath`, and `withUnreadable` (fail-closed finding when a `with:` shape defeats the
  scanner — anchors, quoted flow maps). Handles `with:` before `uses:`, block scalars,
  job-level reusable-workflow `uses:`, and simple one-line flow maps.
- **Metadata**: `fetchDeclaredInputs` reads `action.yml`/`action.yaml` (or, for a
  `…/x.yml@sha` reusable-workflow ref, the workflow itself → `on.workflow_call.inputs`)
  via the contents API at `?ref=<sha>`. Case-insensitive matching (the runner's rule);
  `args`/`entrypoint` accepted only for `runs.using: docker`.
- **403/451 → anonymous git route** (`gitCatFile`): shallow-fetch of the pinned commit into a
  fresh temp repo under `runGit`'s full anonymity env + `cat-file`. Required, not optional:
  the `aquasecurity` org IP-allow-lists the API and we pass inputs to trivy-action — without
  this the check re-creates the permanently-red gate #640 closed. Transport failure ≠ missing
  file; both causes reported; retry only on transport, same as `ls-remote`.
- **Fail-closed everywhere**: unreachable API = failure; metadata this scanner cannot read =
  `action-metadata-unreadable` (never "declares nothing", never a pass); missing metadata
  file = failure. All caches (API, ls-remote, git fetch, per-target inputs) store failures.
- **Scope decision (acceptance criterion 5): every pinned action across every discovered
  file**, not just the publish path — recorded in the script header. `docker://` refs
  excluded (no metadata file; `args`/`entrypoint` are runner-defined).
- **New**: `githubApi` retries a **thrown** fetch once (never an HTTP status — a status is an
  answer). Measured need: one transient `fetch failed` on a memoised request fanned out into
  62 findings.
- PR-time form test (`tests/release-action-pins.test.ts`) untouched — the division of labour
  is deliberate and stays.

## The check caught a REAL live bug on its first run

`release.yml` on `origin/main` pins `changesets/action@…# v2.1.0` but passed all five **v1**
input names (`version`, `publish`, `commit`, `title`, `createGithubReleases`). #747 was closed
in favour of #749 (bump **with** migration, still open/unmerged), but **#831 merged the bump
without the migration** — the exact silent breakage #750 predicted has been live on main
since then; the publish step would have run with every input defaulted and failed only at the
next release. **Fixed here** (release.yml migrated to `version-script`/`publish-script`/
`commit-message`/`pr-title`/`create-github-releases` + the now-required `github-token` input),
mirroring #749's reviewed hunk and crediting it in the comment. #749 should be closed as
superseded once this merges. This duplicates a stalled open PR's hunk deliberately: without it
the nightly reds on merge, on a true positive.

Also measured live: `actions/checkout` ships its `action.yml` with **CRLF** endings, which
made `inputs:` invisible to `$`-anchored regexes (`.` matches no `\r`) and false-redded every
checkout `with:` key. Fixed (`splitLines` on `/\r?\n/`) + regression test.

## Proofs

- **Mutation proof (live network)**: scratch copy of the tree, `severity` →`severityy` in
  `supply-chain.yml` via a script that **asserts the anchor occurs exactly once** and aborts
  otherwise (workflow.md rule). Red, exit 1, naming the **specific key** `severityy`, the
  file:line, and the declared input set — resolved through the 403→anonymous-git route
  (trivy's metadata is `action.yaml`, so the candidate order is proven too).
- **Green proof (live network)**: `node scripts/verify-action-pins.mjs` on the fixed tree —
  exit 0, "every pin … resolves to the tag its comment claims, and every `with:` input passed
  is declared by the pinned action (#750)".
- **Offline mutation proof in vitest**: scratch repo + API double — bogus input reds naming
  the key; corrected input greens; metadata fetched once for four pins (memoisation).
- **Tests**: 26 new in `tests/action-pin-input-existence.test.ts`; full pin-guard suite
  (208 tests across 5 files) green; biome `--diagnostic-level=error` clean (8 warnings
  pre-exist identically on main's copy of the script).
- Full `tests/` sweep: 1770 passed; 10 failures in 4 files (mutation-residue-scan, CLI
  parity, packed-tarball provenance, root-config collect) are **environmental on this
  machine** — identical failures reproduced on the untouched main working copy (GPG
  `FAILURE sign`, 60–170 s subprocess timeouts). Not introduced by this change.

## Files changed

- `scripts/verify-action-pins.mjs` — the check (+ header docs, new findings in
  `formatFinding`, `runGit` cwd param, `githubApi` retry).
- `tests/action-pin-input-existence.test.ts` — new (26 tests, offline doubles).
- `.github/workflows/release.yml` — changesets/action v2 input migration (the live bug).
- `.github/workflows/action-pin-resolution-nightly.yml` — header + alert triage bullet for
  the new finding class.

## Notes for reviewers / escalation honesty

- `release.yml` is a **credentialed publish-path** file; per workflow.md this edit is
  trigger-adjacent. It is the minimal already-reviewed #749 hunk, required for the brief's
  "real workflows pass" clause, and the alternative (merge the checker red) burns the
  nightly's credibility on day one. Flagging rather than hiding it.
- Known limits, stated in the script header: a newly-REQUIRED input we fail to pass is not
  detected; an input whose meaning changed under the same name is invisible; the version
  comment is still trusted as intent.
