# npm-publish environment/tag protection drift check (#1638 item 2)

> Companion to `.github/workflows/npm-publish-drift-nightly.yml`,
> `scripts/lib/npm-publish-drift-check.mjs`, `scripts/check-npm-publish-drift.mjs`.
> Complements the supply-chain section of `threat-model.md` and the action-pin
> resolution nightly (`action-pin-resolution-nightly.yml`), which this workflow
> deliberately mirrors in shape.

## The problem (as originally found) and the decision since (2026-10-02)

The `npm-publish` GitHub Environment gates `release.yml`'s publish job. It had
**no protection rules at all** — `GET /repos/getknext-dev/knext/environments/npm-publish`
answered `"protection_rules":[]` — so a scheduled release run on `main`
published to npm with no reviewer click. There was also no repository ruleset
protecting `v*` tags. Both were confirmed live:

```
$ gh api repos/getknext-dev/knext/environments/npm-publish
{"protection_rules":[], ...}

$ gh api repos/getknext-dev/knext/rulesets
[{"id":13073078,"name":"main","target":"branch", ...}]   # no target: "tag" entry
```

#1638 split the fix in two:

1. **Founder-only (settings applied 2026-10-02).** An active repository
   ruleset, **"release tags (v\* ) immutable"**, now blocks deletion, update,
   and non-fast-forward on any `refs/tags/v*` — creating new tags still works.
   A required reviewer on `npm-publish` was **deliberately not added**: the
   sole maintainer is pre-authorized to publish and asked not to be a
   blocking step. That is a permanent choice, not an open item.
2. **This detector.** A nightly workflow that reads the tag ruleset back
   through the API and fails — with the standard pinned-issue alert — if no
   active ruleset protects `refs/tags/v*`. It also reads the `npm-publish`
   environment's reviewer rule for **information only** (logged, never
   alerted on) — alerting on a setting the founder decided to never configure
   would just be permanent noise, not drift.

## Design

- `scripts/lib/npm-publish-drift-check.mjs` splits into a **pure decision**
  half (`evaluateReviewerProtection`, `matchesVStarGlob`,
  `tagRulesetCoversVStar`, `evaluateTagRulesetProtection` — no network, fully
  offline-tested by `tests/npm-publish-drift-check.test.ts`, mutation-proved by
  `scripts/mutation-prove-npm-publish-drift-check.mjs`) and a **fetch** half
  (`fetchReviewerProtection`, `fetchTagRulesetProtection`, `runDriftCheck` —
  takes an injected `api` function, so the same tests drive it offline against
  a fixture `api: path => ({status, body})`, the same style
  `scripts/verify-action-pins.mjs`'s tests use).
- `scripts/check-npm-publish-drift.mjs` is the thin CLI the workflow runs.
- The two settings are checked **independently**, and every finding names
  which one is missing — never a combined "something is wrong".

### The `v*` glob match

A tag ruleset's `conditions.ref_name.include` entries are GitHub globs
(`*` only, optionally prefixed `refs/tags/`, or the literal `~ALL` meaning
"every ref of this target type"). `matchesVStarGlob` converts a glob to an
anchored regex and tests it against a representative tag (`v1.0.0`) rather
than hardcoding a fixed set of accepted literal strings — a ruleset scoped to
`refs/tags/v*`, `v*`, or `~ALL` all pass; `release-*` does not.

`tagRulesetCoversVStar` (the function that decides whether one ruleset ACTUALLY
protects v*) checks three things, all required:

1. `conditions.ref_name.include` contains a v*-covering glob (above).
2. `conditions.ref_name.exclude` does **not** also cover v* — a ruleset can
   have an `include` that covers v* and an `exclude` that carves it back out
   (a plausible "protect all tags except prereleases" config). Checking
   `include` alone was a false PASS on exactly this axis; both an
   `include`-covers case and an `exclude`-carves-it-back-out case are
   mutation-proved separately.
3. `enforcement === 'active'`. GitHub's other two values are `disabled`
   (filtered out earlier, before the detail fetch) and `evaluate` — a real
   dry-run mode that logs would-be violations but blocks nothing. An
   evaluate-only ruleset would otherwise read as "protected" while a
   force-push or tag deletion goes through unblocked.

## Two different kinds of "not verified" — never conflated

The whole reason this module returns a `kind`, not a bare boolean:

- **`missing`** — the API answered successfully and the setting is genuinely
  absent. This is real drift, and the alert names it as such and points at
  #1638 item 1.
- **`permission-error`** — a 403/404 from either endpoint. This does **not**
  mean the setting is empty — it means the check could not read it. The alert
  text says so explicitly and never lets a permission failure read as "the
  founder hasn't configured this yet".

Collapsing those two into one message is exactly the failure mode this design
avoids: a token-scope regression would otherwise read identically to real
drift, and nobody could tell which one to fix.

## Token-permission finding

- `actionlint` rejects `environments:` as a workflow `permissions:` key
  outright — it is not one of GITHUB_TOKEN's enumerable permission scopes.
  There is nothing narrower to grant for the environment-protection-rules GET;
  it rides on the token's ordinary repo-read access.
- GitHub's REST docs list the repository-rulesets endpoints under the
  "Administration" repository permission, which likewise has no dedicated
  GITHUB_TOKEN `permissions:` key.
- **Live-tested** against this repo, fully **unauthenticated** (no token of
  any kind): both `GET environments/npm-publish` and `GET rulesets` (plus a
  ruleset detail fetch) answered `200`, not `403`/`404` — an anonymous request
  already has enough access to read this public repo's environment protection
  rules and rulesets. `GITHUB_TOKEN` in Actions presents at least that much
  access, so the nightly is expected to resolve both reads cleanly (the tag
  ruleset as `ok`, the reviewer rule as `missing` — informational only) without
  any extra token.
- **If that expectation turns out wrong on the Actions runner specifically**
  (the first live scheduled run is the actual proof — this workflow cannot be
  exercised by PR CI, since it is `schedule` + `workflow_dispatch` only): the
  fix is a fine-grained PAT scoped to this repo with **"Administration:
  Read-only"**, stored as a repo secret (e.g. `NPM_PUBLISH_DRIFT_CHECK_TOKEN`),
  swapped in for `GITHUB_TOKEN` in the workflow's `env:` block. That secret
  does not exist yet — nothing in this PR requires it, and it should only be
  added if a real nightly run reports `permission-error`.

## What this does not do

- It does not add a required reviewer — by founder decision that setting stays
  absent permanently (#1638 item 1, settings applied 2026-10-02).
- `release.yml`'s header comment (item 3) is corrected in the same PR as this
  scope change, to stop claiming a required reviewer exists.
- It does not gate PR merges — it is a nightly detector, same reasoning as
  `action-pin-resolution-nightly.yml`: the answer lives in live repo settings,
  not in anything a PR's diff touches, so a PR-blocking version would fail
  every PR for a founder-only setting no PR can fix.

## Deployment-branch policy (fails the nightly)

The check also reads the `npm-publish` environment's `deployment_branch_policy`
and **fails** when it is `null` (any branch can run a job that names the
environment and receive `NPM_TOKEN`), when it only restricts to protected
branches, or when it admits any ref outside the exact publish-lane allowlist in
`scripts/publish-lane-guard.mjs` (wildcards never match). The allowlist is
imported, not copied. Until the maintainer applies an exact-ref branch policy on
the environment, the nightly is red by design: that red is the reminder.

To exercise the exit code offline, pass `--fixture <json>`, a map of API path to
`{status, body}`: `node scripts/check-npm-publish-drift.mjs --fixture f.json`.
