# ADR-0039: The compat-window freeze scope — what "the harness unchanged" means

- **Status:** Accepted (2026-07-28; sprint-2 decision D-1, `docs/SPRINT_2.md`). **Amends D-1's
  `dist/cli/**` exclusion, which is not implementable as written** — see the Decision. Implemented by
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

**Freeze the harness plus each packed `@getknext/*` tarball in full, and prove it with a per-run
digest.** The digest is over **shipped bytes** — what the night actually installed — not over the
adapter's execution closure. The two are different claims, and the distinction is the whole content
of the correction below.

**The frozen set** — the digest's two components:

| component | contents | scanned how |
|---|---|---|
| `harness` | `.github/workflows/test-e2e-deploy.yml`; `scripts/e2e-*.{sh,mjs,cjs,js}`; `test/deploy-tests-manifest.*.json` | directory scan + pattern, never a file list |
| `packed` | every `*.tgz` in the run's tarballs dir — each `@getknext/*` package **in full**, hashed by **extracted contents** | scan the dir, then scan each package tree, **no filter** |

**`dist/cli/**` is INSIDE the frozen set, not excluded.** An earlier draft of this ADR claimed the
opposite; it was wrong, and the correction matters more than the claim did (architect gate, PR #574):

- `packages/kn-next/package.json` has `files: ["dist"]` and `bin: ./dist/cli/kn-next.js`, so
  **`dist/cli/**` ships inside the tarball under test** — the very artifact each fixture installs;
- a path-prefix filter could not rescue the exclusion even if we wanted one: of the 9 chunks
  `dist/cli/*` references, **8 are also referenced by non-CLI dist files**. A CLI change that
  perturbs a shared chunk rotates its content-hashed filename, which rewrites import specifiers in
  adapter entries too. There is no seam to cut along.

**So a CLI change resets the window.** The sequencing cost D-1 was trying to avoid is already paid:
S10 landed in #572 and the window is not open, so nothing is lost by stating this correctly.

**Explicitly not in the frozen set:** `scripts/compat-smoke.mjs` and `ci.yml` — a *different*, PR-time,
app-side gate. Confusing the two is the most likely way to widen this scope by accident.

**Any change inside the frozen set restarts the 14 nights.** That is the contract statement users
and maintainers may rely on, and it is now checkable: each scheduled run records
`windowFingerprint` in `compat-run-ledger.json` and in the job summary, retained 90 days — long
enough to outlive the window it attests to.

### What the closure guard proves — and what it does not

`scripts/adapter-import-closure.mjs` walks `src/adapters/next-adapter.ts`'s transitive import
closure — static, dynamic `import()` and `require()` alike — and fails if any member resolves under
a `cli/` directory, including via the `./internal/cli-validate` and `./internal/cli-shared` subpath
exports. An unresolvable relative import is a **hard error**, not a skip: a walker that drops what it
cannot resolve is a permanently-green guard.

**Be precise about the claim it supports.** It proves the adapter never *executes* CLI code. That
makes `src/cli/` **review-safe** — a CLI defect cannot corrupt a compat result — but it does **not**
make CLI changes **window-safe**, because the digest hashes *shipped bytes*, not the execution
closure. Two different claims; conflating them is exactly the error this ADR shipped with and the
architect gate caught. The guard is kept for the execution claim, which is worth having on its own:
it is what would catch an adapter quietly gaining a CLI dependency.

### Suite provenance: recorded, not frozen

`NEXTJS_REF: v16.2.0` is a git **tag**, resolved fresh each night, and that checkout supplies
`run-tests.js` and the compat suite itself. A retag therefore moves what "green" means while the
fingerprint stays identical — a real hole, and one the frozen set cannot close, since the suite is
not ours to freeze.

The fingerprint artifact records `recorded.suite.nextJsCommit` (the resolved `git rev-parse HEAD` of
the `next.js` checkout) and `recorded.suite.nextTarballSha256`, and the ledger carries them.
Deliberately **outside the digest**: folding them in would make every legitimate suite bump a silent
window reset, when it should be a visible decision. `recorded.suite.frozen: false` is written into
the JSON so a reader cannot mistake the fields for frozen ones.

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
| **Freeze the harness + each packed tarball in full, prove with a scanned digest** | window is checkable; the digest covers exactly what the night installed, with no seam to argue about | a CLI-only change resets the window | **chosen** |
| Freeze everything in the repo (`git rev-parse HEAD` as the fingerprint) | trivial to implement; nothing can slip | every merge — docs, ADRs, operator, benchmarks — resets the clock. The window becomes a merge freeze, and 1.0 becomes unreachable for organisational reasons | rejected |
| Freeze the harness only (workflow + scripts + manifest) | small, obvious | omits the packed `@getknext/*` closure — the adapter under test. The digest would be stable across a night that ran different code: the exact silent failure this ADR exists to prevent | rejected |
| Exclude `dist/cli/**` from the packed digest (this ADR's first draft) | CLI work could land mid-window, preserving sprint capacity | **not implementable**: `files: ["dist"]` + `bin: ./dist/cli/kn-next.js` ship the CLI in the tarball under test, and 8 of 9 chunks `dist/cli/*` references are shared with non-CLI dist files, so a path filter cannot separate them. It also conflated "the adapter does not *execute* CLI code" with "the tarball does not *contain* it" | rejected (corrected on #574) |
| Fold the suite provenance into the digest | a retag would reset the window automatically | every legitimate suite bump becomes a silent 14-night reset with no decision recorded anywhere | rejected — record it instead |
| Hash tarball bytes | simplest packed digest | not reproducible; the window would never hold | rejected |
| No fingerprint; keep a hand-written window log | zero work | the status quo, and the reason this ADR exists | rejected |

## Consequences

- **May now rely on:** "green" names a specific, digested artifact set, and every scheduled run
  emits **retained, tamper-evident evidence** of which set it ran — the digest, its two component
  digests, a per-package digest, and the recorded suite provenance, kept 90 days so it outlives the
  window it attests to. That is what makes the 14-night claim *checkable after the fact* by someone
  other than the person who wrote the log.
- **Precisely what this does NOT do, stated because the first draft overclaimed it:** nothing
  compares tonight's digest to last night's. CI fails on a **missing** fingerprint only. A
  mid-window change therefore produces a *different recorded digest*, not an automatic alarm —
  detection still requires someone (or S2's log) to read the two. Cross-run comparison is the
  follow-up below, and only once it lands is "a mismatch voids the window loudly" a true sentence.
- **What just broke:** any change inside the frozen set restarts the 14 nights — including a
  comment-only edit to `test-e2e-deploy.yml`, and including a CLI-only change, since `dist/cli/**`
  ships in the tarball. Deliberate: a fingerprint that tries to be clever about which changes
  "matter" is one someone can argue with.
- A scheduled run that records **no** fingerprint fails the ledger job. A night with no recorded
  harness identity cannot count toward the streak.
- **Branch protection (#555) is not a precondition for this ADR's guarantee.** Without it, a
  mid-window merge does not make the 14-night claim *false* — the digest changes and the streak
  restarts. Detection suffices for **truth**; prevention is about **schedulability**, i.e. whether
  the streak can be completed in reasonable wall-clock time. This ADR buys falsifiability, not
  prevention, and that is enough for correctness.
- Not covered: the **runner environment** (ubuntu image, Node 24.x patch) can still move under a
  stable digest. The suite half of that gap is now *recorded* (see above) rather than merely noted;
  the runner-image half is not.

## Action items

- [x] `scripts/compat-window-fingerprint.mjs` — scanned digest over both components, hard-failing on
      an empty or foreign packed set.
- [x] `scripts/adapter-import-closure.mjs` + `tests/compat-window-cli-exclusion.test.ts` — the
      adapter **execution**-closure guard (never a freeze exclusion), mutation-proved against
      relative, transitive, dynamic and subpath-export imports.
- [x] Wire the fingerprint into `test-e2e-deploy.yml`: computed in `build-next` from the same packed
      tarballs the shards install, uploaded 90 days, carried in `compat-run-ledger.json`.
- [x] Record suite provenance (`next.js` HEAD + `next` tarball sha256) as **recorded, not frozen**.
- [ ] **Cross-run comparison** — the ledger job reads the previous scheduled run's fingerprint
      artifact and fails loudly on a mismatch mid-window. This is what makes "a mismatch voids the
      window loudly" true; until it lands, the fingerprint is evidence, not an alarm.
- [ ] **S2** — open the window and record the fingerprint per night in
      `docs/compat/window-node-lane.md`; a mismatch restarts the count.
- [ ] **S3 (#555)** — branch protection on `main`. Improves *schedulability* of the streak; not a
      precondition for the guarantee (see Consequences).
- [ ] Consider recording the runner image identity if an environment-skew incident ever makes that
      residual gap concrete.
