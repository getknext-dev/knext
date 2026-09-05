# Spec review — PR #961 vs issue #954

Verdict: **ISSUES_FOUND** (all three ACs met; one substantive claim-vs-evidence defect in the
same-class sweep, one minor docs drift).

## Acceptance criteria

| AC | Verdict | Evidence |
|----|---------|----------|
| 1. Lookup resolves the entry for the version actually staged | **MET** | `native-integrity.ts` `readLockfilePackages` now returns `Map<string, LockedPackage[]>`; `writeNativeIntegrityManifest` does `versions.find(v => v.version === pkg.version)` and records the *matched* entry's integrity. |
| 2. Genuine mismatch still fails closed | **MET** | Two refusals preserved: `!versions` (no such package) and `!entry` (no such version). New message names every pinned version via `formatVersions`. |
| 3. Test with the scaffold's real dependency shape | **MET** | `native-integrity.test.ts` `#954` block: bare keys at next's 0.34.5, nested `myapp/…` at the app's 0.35.4 — matches the reproduced shape in `docs/verification/sprint2-aggregate-2026-09-05.md` B-3 ("staged at 0.35.4 but bun.lock pins 0.34.5", i.e. the *hoisted* @img entry was next's 0.34.5). Three cases: nested-match passes, root-match passes, neither fails closed. |

## Red-first evidence — verified analytically against the base tree

Traced base `readLockfilePackages` (`if (!out.has(name) || key === name) out.set(...)` → bare key
always wins) + base `writeNativeIntegrityManifest` (`if (entry.version !== pkg.version) throw`)
against the new fixture:

- test 1 (staged 0.35.4, bare pin 0.34.5) → base throws → **red before the fix**. Genuine reproduction.
- test 3's second assertion `/0\.34\.5.*0\.35\.4|…/s` → base message says "pins 0.34.5" only → **red**.
- test 2 (staged 0.34.5) passes on base — correctly labelled a regression pin, not red-first.

Mutation M7 is faithful: `if (existing === -1 && entries.length > 0) continue;` restores the
one-version-per-name collapse and test 1 kills it. M3's `?? versions[0]` is a clean tolerance
mutation killed by test 3 (green-if-deleted on the disambiguation holds).

## Issue 1 — the `[0]` sweep in `vinext-build.ts` claims a property it does not have (MEDIUM)

`vinext-build.ts:~338` takes `locked.get(name)?.[0]` with the comment: *"fetching 'whichever entry
won a name-keyed map' would stage an addon version the bundled sharp never resolved."*

Under the shape this PR itself documents, `[0]` **is** that wrong version:

- B-3 evidence + the PR's own `native-integrity` fixture put the **bare/hoisted `@img` key at next's
  0.34.5**, while the app bundles sharp **0.35.4**. sharp pins its `@img/sharp-<platform>` addons at
  its own exact version, so `[0]` fetches the addon the bundled sharp never resolved.
- The two fixtures in this PR contradict each other on which version sits at the bare key:
  `vinext-build.test.ts` sets root = `SHARP_V` = 0.35.4 (the app's), `native-integrity.test.ts` sets
  root = 0.34.5 (next's). Only one can be the scaffold's real shape, and the evidence doc says it is
  the latter — so the new fetch-path test passes on a fixture that inverts the documented reality.
- Consequence: on the primary fetch case (macOS host → linuxmusl target, #949/C-1a) a fresh scaffold
  would stage `@img/sharp-linuxmusl-x64@0.34.5` beside sharp 0.35.4, and the integrity manifest
  *passes* (0.34.5 is in the lock), so the guard cannot see it. That is the C-1b hazard class.
- Not a regression: base `locked.get(name)` also resolved to the bare-key entry. So this is a
  claim/documentation defect plus a missed correctness opportunity, not new breakage.

Sound selector: resolve `sharp`'s own staged/bundled version and fetch the `@img` package at *that*
version, falling back to `[0]` only when sharp is unresolvable. If that is out of scope for #954,
the comment and PR body must be corrected to say "deterministic, root-hoisted — NOT necessarily the
version the bundled sharp resolved" and a follow-up issue filed.

## Issue 2 — docs step (MINOR)

The "no user-visible change" claim is *mostly* fair: no docs page quotes the integrity error text,
and the removed false-fail has no documented workaround to retract. But
`apps/docs/content/docs/image-optimization.mdx:63` states the build "downloads **the exact version
your `bun.lock` pins**" — with two versions pinned that sentence is now imprecise, and it describes
exactly the path this PR changed. One clause covering the two-version case is warranted.

## Nit

`formatVersions` sorts lexically — `0.9.0` would sort after `0.10.0`. Cosmetic (message text only).

## Base-branch choice

Sound. `agent/s3-integrity-collision` stacks on `agent/s3-darwin-sharp` (#958), which is an ancestor
(`ANCESTOR_YES`) and owns the recent edits to both `native-integrity.ts` and `vinext-build.ts`.
No duplicated or reverted hunks.
