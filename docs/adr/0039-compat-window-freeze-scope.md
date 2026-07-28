# ADR-0039: The compat-window freeze scope — what "the harness unchanged" means

- **Status:** Accepted (2026-07-28; sprint-2 decision D-1, `docs/SPRINT_2.md`). Implemented by
  `scripts/compat-window-fingerprint.mjs` + `scripts/adapter-import-closure.mjs` and wired into
  `.github/workflows/test-e2e-deploy.yml` (#545, task S1).
- **Depends on:** ADR-0007 (the official-suite compat gate), `docs/V1_ROADMAP.md` (which makes the
  window a 1.0 release gate), `.claude/rules/workflow.md` (design gates, mutation-proof discipline)
- **Governs:** the north-star hard rule "gate every parity claim on the official compatibility
  suite" (`CLAUDE.md` §10)

## Context

v1.0 is gated on **14 consecutive scheduled node-lane runs of the official compat suite with the
harness unchanged**. Two words in that sentence did all the work and neither was defined:

- **"the harness"** — no path list existed. Sprint 1 proved the hole by scheduling work on
  `adapters/shutdown.ts` and `src/cli/` *concurrently with opening the window*; under any literal
  reading both reset the clock, and nobody noticed.
- **"unchanged"** — nothing recorded the state of anything per night. The window would be policed
  by a human reading a log they also wrote. **As specified, the guarantee was unfalsifiable.**

A third fact makes the scope non-obvious rather than merely undocumented: the workflow does not test
the repo, it tests **what it packs**. `test-e2e-deploy.yml` builds and `pnpm pack`s `@getknext/lib`,
`@getknext/db` and `@getknext/core`, and every fixture app installs those tarballs. The packed
closure *is* the adapter under test, so a fingerprint over the repo's workflow files alone would go
unchanged across a night that exercised different code.

## Decision

**Freeze the adapter-executed surface, and prove it with a per-run digest.**

**The frozen set** — the digest's two components:

| component | contents | scanned how |
|---|---|---|
| `harness` | `.github/workflows/test-e2e-deploy.yml`; `scripts/e2e-*.{sh,mjs,cjs,js}`; `test/deploy-tests-manifest.*.json` | directory scan + pattern, never a file list |
| `packed` | every `*.tgz` in the run's tarballs dir — the `@getknext/*` closure, hashed by **extracted contents** | scan the dir, then scan each package tree |

**Explicitly excluded: `dist/cli/**`.** CLI work (notably the S10 prune preflight, the largest
remaining P1 item) may land while the window is open. Without this exclusion the whole of sprint 2
would have to wait out 14 nights.

**Explicitly not in the frozen set:** `scripts/compat-smoke.mjs` and `ci.yml` — a *different*, PR-time,
app-side gate. Confusing the two is the most likely way to widen this scope by accident.

**Any change inside the frozen set restarts the 14 nights.** That is the contract statement users
and maintainers may rely on, and it is now checkable: each scheduled run records
`windowFingerprint` in `compat-run-ledger.json` and in the job summary, retained 90 days — long
enough to outlive the window it attests to.

### Why the exclusion is not free, and what keeps it honest

`packages/kn-next/package.json` exports `./internal/cli-validate` and `./internal/cli-shared` from
`dist/cli/`. So "the adapter never executes CLI code" is a property of today's imports, not of the
package layout — one import would silently void it, and the freeze would then be excluding code the
night actually ran.

Checked rather than assumed: `src/adapters/next-adapter.ts` imports only node builtins, `next` types
and `./standalone-bun-exports`, whose own closure stays inside `src/adapters/`. `scripts/adapter-
import-closure.mjs` walks that closure transitively — static, dynamic `import()`, and `require()`
alike — and fails if any member resolves under a `cli/` directory, including via those two subpath
exports. An unresolvable relative import is a **hard error**, not a skip: a walker that drops what it
cannot resolve is a permanently-green guard.

### Why the digest hashes tarball CONTENTS, not tarball bytes

`pnpm pack` is not bit-reproducible (gzip embeds an mtime), so a byte digest would churn every
night and **no window could ever hold** — for reasons that are not code changes. The fingerprint
extracts each tarball and hashes `path + executable bit + sha256(content)` per file. The executable
bit is part of the identity: a lifecycle script that loses `+x` changes what the night ran.

### Why scanned, not enumerated

An enumerated list is how the second file gets missed — this repo has hit that twice this sprint.
The roots are directories plus patterns, so a newly-added `scripts/e2e-*.sh`, a second manifest lane,
or a fourth packed package moves the digest with no edit to the script. Correspondingly, a root that
matches **zero** files is a hard error rather than a quietly-empty component.

## Options considered

| option | pro | con | verdict |
|---|---|---|---|
| **Freeze the adapter-executed surface, exclude `dist/cli/**`, prove with a scanned digest** | window is checkable; sprint keeps its capacity; the exclusion is guarded, not asserted | one more script + guard to maintain | **chosen** |
| Freeze everything in the repo (`git rev-parse HEAD` as the fingerprint) | trivial to implement; nothing can slip | every merge — docs, ADRs, operator, benchmarks — resets the clock. The window becomes a merge freeze, and 1.0 becomes unreachable for organisational reasons | rejected |
| Freeze the harness only (workflow + scripts + manifest) | small, obvious | omits the packed `@getknext/*` closure — the adapter under test. The digest would be stable across a night that ran different code: the exact silent failure this ADR exists to prevent | rejected |
| Exclude `dist/cli/**` on the strength of reading the imports | no new code | "verified once" decays silently; the two `dist/cli/` subpath exports make one import enough to void it | rejected |
| Hash tarball bytes | simplest packed digest | not reproducible; the window would never hold | rejected |
| No fingerprint; keep a hand-written window log | zero work | the status quo, and the reason this ADR exists | rejected |

## Consequences

- **May now rely on:** "green" names a specific, digested artifact set; each night's entry in the
  window log (`docs/compat/window-node-lane.md`, S2) carries the fingerprint, and a mismatch voids
  the window loudly instead of being negotiated after the fact.
- **What just broke:** any change inside the frozen set restarts the 14 nights — including a
  comment-only edit to `test-e2e-deploy.yml`. This is deliberate: a fingerprint that tries to be
  clever about which changes "matter" is a fingerprint someone can argue with.
- A scheduled run that records **no** fingerprint fails the ledger job. A night with no recorded
  harness identity cannot count toward the streak.
- The window is **not** protected against a mid-window merge landing on `main` — branch protection
  (#555) is a separate, human-only gate. The fingerprint makes such a merge *detectable*, not
  impossible. Stated rather than implied: this ADR buys falsifiability, not prevention.
- Not covered: the fingerprint says nothing about the **runner environment** (ubuntu image, Node
  24.x patch, the pinned `next@16.2.0` tarball's registry bytes). Those can move under a stable
  digest. `NEXTJS_REF` is inside the workflow file and therefore inside the digest, but the resolved
  tarball is not.

## Action items

- [x] `scripts/compat-window-fingerprint.mjs` — scanned digest over both components, hard-failing on
      an empty or foreign packed set.
- [x] `scripts/adapter-import-closure.mjs` + `tests/compat-window-cli-exclusion.test.ts` — the
      `dist/cli/**` exclusion guard, mutation-proved against relative, transitive, dynamic and
      subpath-export imports.
- [x] Wire the fingerprint into `test-e2e-deploy.yml`: computed in `build-next` from the same packed
      tarballs the shards install, uploaded 90 days, carried in `compat-run-ledger.json`.
- [ ] **S2** — open the window and record the fingerprint per night in
      `docs/compat/window-node-lane.md`; a mismatch restarts the count.
- [ ] **S3 (#555)** — branch protection on `main`, so a mid-window merge is prevented and not merely
      detected.
- [ ] Consider extending the digest to the resolved `next` tarball digest if a version-skew incident
      ever makes the runner-environment gap concrete.
