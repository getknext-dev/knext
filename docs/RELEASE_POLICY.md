# knext release & support policy

> Internal maintainer doc — it may reference issues and workflow internals. The **mechanics** of
> publishing (auth, the workflows, the interim GitHub Packages channel) live in
> [`docs/RELEASING.md`](RELEASING.md); this document is the **policy** that gives a published
> version its meaning. The version-by-version compatibility table is
> [`docs/COMPATIBILITY.md`](COMPATIBILITY.md).
>
> Scope split: issue #53 owns the npm scope-drift resolution and the first publish. Issue #314
> owns this policy, the compatibility matrix, and the guard that enforces both
> (`tests/release-policy-matrix.test.ts`).

Anything below labelled **(aspirational)** is a stated intent that nothing in the repo enforces
yet. Everything else describes what the repo actually does today.

## The release set

Three packages are published to the public npm registry, and they are published **as a set**:

| Package          | Path               | Contains                                           |
| ---------------- | ------------------ | -------------------------------------------------- |
| `@getknext/core` | `packages/kn-next` | the `kn-next` CLI, the Next.js adapter, the runtime |
| `@getknext/lib`  | `packages/lib`     | app-facing runtime helpers (clients, health, logs)  |
| `@getknext/db`   | `packages/db`      | the Drizzle data SDK + migration runner             |

`@getknext/core` depends on both of the others, and `@getknext/db` depends on `@getknext/lib`, so
publishing a partial set 404s every consumer install — that is the #255/#256 incident, not a
hypothetical. Everything else in the workspace (`@getknext/ui`, `apps/*`, `examples/*`,
`packages/scale-zero-pg`) is `"private": true` and never reaches a registry. The Go operator is
released as a **container image**, on its own version line — never via npm.

**The three carry one version number.** This is enforced two ways, because the intent alone already
decayed once: `packages/db/CHANGELOG.md` promised "all three bump together and ship as a set" while
the tree drifted to core `0.3.0` / db `0.2.1` / lib `0.2.0`. So:

- `.changeset/config.json` declares the three as a **`fixed` group** — Changesets bumps all three to
  the same version whenever any of them changes, whether or not a changeset mentions the others;
- `tests/release-policy-matrix.test.ts` **scans** the workspace (it never reads a list) and fails if
  the versions diverge, if the `fixed` group goes missing, or if a fourth publishable package
  appears.

A consumer therefore pins one number: `@getknext/core@x.y.z` implies `@getknext/lib@x.y.z` and
`@getknext/db@x.y.z`.

## Release cadence

There is **no calendar cadence.** knext releases when a change is ready, driven by Changesets:

1. a PR that changes a released package includes a changeset (`pnpm changeset`);
2. merging it to `main` makes `changesets/action` open or update the **"version packages"** PR,
   which applies the bumps and writes the changelogs;
3. merging **that** PR publishes the whole set and creates one GitHub Release per package.

This is deliberate for the current phase: a fixed train would either ship empty releases or hold
finished work back, and there is one maintainer. It also means **there is no such thing as a
scheduled security release** — a security fix ships when its "version packages" PR merges, at
whatever version number the accumulated changesets produce.

**(aspirational)** Once there are external adopters, move to a predictable minor train (monthly or
six-weekly) with patches out-of-band. Nothing today depends on that happening.

## What a version number promises

The three packages follow [semantic versioning](https://semver.org/) over the surface documented in
[`docs/PUBLIC_API.md`](PUBLIC_API.md) — and **only** that surface:

- **patch / minor** never remove or break a public import; minors may add public imports;
- **major** is required to remove, rename, or change the signature of any public import;
- **internal subpaths** (`@getknext/core/internal/*`, and any subpath not listed in
  `PUBLIC_API.md`) carry **no** guarantee and may change in a patch;
- **the `kn-next` CLI** — its verbs, flags, and `kn-next.config.ts` schema — is covered by the same
  rules: removing a flag or rejecting a previously-valid config key needs a major.

Pre-1.0 caveat, stated rather than hidden: while the leading digit is `0`, semver itself allows
breaking changes in a minor. knext does not use that licence — the rules above are applied as
written — but the npm ecosystem's default range for a `0.x` dependency (`^0.3.0`) will not pick up
`0.4.0` anyway, so **pin exactly, or accept that minors need a manual bump.**

### What a version number does *not* promise

- **It does not describe the cluster side.** The `NextApp` CRD ships with the operator image, on the
  Kubernetes `v1alpha1` → `v1beta1` → `v1` ladder. A major of `@getknext/core` does not graduate the
  CRD, and graduating the CRD does not force an npm major. See
  [`docs/COMPATIBILITY.md`](COMPATIBILITY.md).
- **Within `v1alpha1` the CRD schema is additive-only** (ADR-0017 §2.1): fields are added, never
  removed or narrowed, so a `NextApp` that applies today keeps applying against later operators.
  What is *not* frozen is a field's **meaning** — a field may become inert, and that is announced in
  the **release notes**, never as a rejected write. A support policy promising frozen behaviour
  would be promising something the CRD cannot keep.

  The mechanism, stated at the level it actually exists: ADR-0017 commits to the **release notes**
  and nothing more. The one shipped precedent — `spec.cache.enableBytecodeCache`, superseded by the
  image-baked compile cache — also emits a **Warning Event** on the resource
  (`DeprecatedBytecodeCachePVC`, `nextapp_controller.go:726`). There is **no** deprecation status
  condition, and do not write one into a policy: a new condition has to go through
  `computeStatusVerdict` per `.claude/rules/architecture.md`, so promising one here would commit
  someone to unplanned work.
- **It does not pin your images.** Deployed apps are pinned by digest; the operator rejects
  `:latest`.

## Support window

**The latest release line is the supported one.** Fixes — including security fixes — land on the
next release cut from `main`. There are **no backport branches**, and no patch releases are cut
against an older minor.

The honest reason is capacity, not principle: knext is pre-1.0 and single-maintainer. A support
matrix promising N-1 maintenance would be a promise nobody is staffed to keep, and the first missed
backport would cost more credibility than the promise ever bought.

What that means in practice for someone operating knext:

- **upgrade forward to get a fix.** Because minors are additive over the public surface, upgrading
  within a `0.x` line is a version-number change plus a re-deploy;
- **the upgrade is not all-or-nothing.** Operator and CLI version independently — see the
  compatibility matrix — so a cluster-side fix can be taken without moving every CI pipeline's CLI
  on the same day, provided the ordering rule is kept;
- **(aspirational)** advisories go out as **GitHub Security Advisories** on the repo, referenced
  from the release notes. Labelled aspirational for the same reason as the items below: the
  advisory list is currently **empty** (`gh api /repos/getknext-dev/knext/security-advisories` →
  `0`), so this is the intended channel, not an established practice.

**(aspirational)** At 1.0, adopt a documented N-1 window: the current minor plus the previous one
receive security fixes for a stated number of months. Do not write that into user-facing docs
before someone is committed to doing the backports.

## Deprecation

Removing something is a two-release process, never a single one:

1. **Announce.** The item is marked `@deprecated` in its types (so a consumer sees it in their
   editor), noted in the changelog entry for that release, and given a named replacement. A
   deprecation ships in a **minor**.
2. **Remove.** No earlier than the next **major**, and never less than one minor release after the
   announcement — so there is always a version a consumer can run that carries both the warning and
   the old behaviour.

Applies to: public imports, CLI verbs and flags, and `kn-next.config.ts` keys.

> **UNRESOLVED — needs an architect call, do not read this as settled.** Combine step 2 ("no earlier
> than the next major") with the pre-1.0 caveat above ("knext does not use semver's 0.x allowance")
> and the result is that **nothing public can be removed before 1.0** — on a CLI and config surface
> that is still actively churning. That is a real constraint nobody has agreed to, and it was
> reached by composing two reasonable-looking rules rather than by deciding it.
>
> The three plausible resolutions, none chosen here: (a) accept the freeze and let the surface grow
> until 1.0; (b) take semver's 0.x allowance explicitly — removals permitted in a `0.x` **minor**
> after a deprecation minor — and say so loudly on the user-facing page; (c) reach 1.0 sooner so the
> normal major cadence applies. Until this is decided, treat a proposed removal as an escalation,
> not as something this document already permits or forbids.

CRD fields are the exception, and deliberately so: within `v1alpha1` a field is **never removed**
(additive-only), so the deprecation path for a CRD field is to make it inert and say so in the
release notes. Removing it requires a new API version.

The interim GitHub Packages scope (`@getknext-dev/*`) has its own dated deprecation plan, which
executes the day the npmjs publish lands — it lives in
[`docs/RELEASING.md`](RELEASING.md#deprecation-plan-for-getknext-dev-execute-when-npmjs-goes-live).

## Keeping this honest

`docs/COMPATIBILITY.md` gains its row **on `main`, before the "version packages" PR merges** — not
inside that PR. `changesets/action` force-pushes the `changeset-release/main` branch on every
subsequent push to `main`, so a row hand-added there disappears if anything merges ahead of it, and
the loss reads as a flaky guard rather than a lost commit. `changeset status --output` prints the
exact `newVersion` ahead of time, so the row can always be written first.

The guard asserts the matrix carries a row for the version currently in the tree, so a release
without its row stays red. It also checks that **every** row's CRD `apiVersion` cell equals both the
one ADR-0017 declares and the one the operator's manifests actually serve, so the matrix cannot
agree only with itself.

What the guard does **not** check, so nobody assumes it does:

- it cannot verify that a version on a registry matches this tree, and it cannot tell whether a
  support-window promise was kept — those remain human commitments;
- **the prose checks are heading- and name-level, not comprehension.** Replacing the user-facing
  page with a stub that names the three packages keeps them green. That is close to the ceiling for
  asserting on prose, but it means these checks catch *deletion*, not *wrongness* — the substance
  of a policy still needs a reader.
