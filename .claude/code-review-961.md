# Adversarial code review — PR #961 (native-integrity two-version lockfile disambiguation, closes #954)

Branch `agent/s3-integrity-collision` → base `agent/s3-darwin-sharp`. Read-only.

**Verdict: ISSUES_FOUND** (1 blocking, 1 contract hole, 2 minor)

---

## F1 (BLOCKING) — `vinext-build.ts:341` `[0]` picks the version the app does NOT bundle, in exactly the #954 scenario

```ts
// packages/kn-next/src/cli/vinext-build.ts:336-341
// "`[0]` is the lockfile's canonical (root/hoisted) resolution … fetching
//  'whichever entry won a name-keyed map' would stage an addon version the
//  bundled sharp never resolved."
const entry = locked.get(name)?.[0];
```

The premise "bare key == the resolution the app bundles" is contradicted by three
independent pieces of evidence, two of them inside this PR:

1. **#954's own reproduction.** The reported error is
   `'@img/sharp-wasm32' is staged at 0.35.4 but bun.lock pins 0.34.5`. Under the OLD
   parser the surviving entry was the bare key when one existed (`if (!out.has(name) || key === name)`),
   else first-in-file. Either way the entry `[0]` now returns for that lock is **0.34.5**,
   while the app's on-disk / bundled resolution was **0.35.4**.
2. **This PR's own fixture** encodes the same shape:
   `native-integrity.test.ts:288-292` puts `NEXT_SHARP = 0.34.5` at the **bare** keys
   (`"sharp"`, `"@img/sharp-linux-x64"`) and `APP_SHARP = 0.35.4` under the nested
   `myapp/…` keys — i.e. the fixture asserts the app's real version is the NESTED one.
3. **`tests/template-sharp-pin.test.ts`** — every template pins `sharp ^0.35.x`, and
   #949 C-1b proves the compile's dlopen-shim `onLoad` filter only matches ≥0.35's
   `dist/sharp.(m|c)js` layout. The bundled sharp is 0.35.x by construction.

So the two new tests encode **contradictory models of which entry is the app's**:
`native-integrity.test.ts` says the app is the nested 0.35.4; `vinext-build.test.ts:349-353`
asserts the fetch path takes the ROOT entry. Applied to the *same* lock, a macOS host
(the #949 / `agent/s3-darwin-sharp` primary path) fetches
`@img/sharp-linuxmusl-x64@0.34.5` into an image whose bundled sharp is 0.35.4.

**And it ships silently.** After the fetch, `writeNativeIntegrityManifest` compares the
staged 0.34.5 against the lock, finds it (bare key), and passes. The dlopen shim only
re-hashes staged files. `git grep -n "sharpVersion\|node_modules/sharp\|resolvedSharp"`
over `packages/kn-next/src/cli` on this branch returns **nothing** — there is no
cross-check anywhere between the staged `@img` version and the resolved `sharp` version.
Net effect: #949's "image cannot load sharp" crash-loop class returns, version-mismatched
instead of platform-mismatched, with no guard between it and production.

**Fix direction.** The staged pin must follow the APP's resolution, not "first in lock".
The information is already available on the fetch path: the host install (`imgRoot`) holds
the app's own platform addons at the app's sharp version, and `node_modules/sharp/package.json`
gives it directly. Select
`versions.find((v) => v.version === resolvedSharpVersion)`, and only fall back to `[0]`
when the sharp version genuinely cannot be resolved (documenting that fallback as such).
Add a test with the `native-integrity.test.ts` shape (bare = next's pin, nested = app's)
asserting the fetch takes the APP's version.

## F2 — the ordering contract's "when present" caveat is dropped at the call site

`native-integrity.ts:212-218` is honest: bare-key resolution first **"when present"**.
`vinext-build.ts:336-341` restates it unconditionally ("`[0]` **is** the canonical
resolution … deterministically, regardless of entry order"). The same function's docstring
(`native-integrity.ts:206-208`) notes workspace installs key entries by path
(`apps/x/node_modules/@img/y`) — in that shape **no bare key exists**, and `[0]` is simply
first-in-file. That is deterministic *given the file*, not order-independent as claimed.
No test covers the no-bare-key case. Either handle it explicitly or downgrade the comment
and the test name (`vinext-build.test.ts:339`) to what is actually true.

## F3 (minor) — `vinext-build.test.ts:339` is green before the fix, not red-first

Old code's `key === name` overwrite already made the bare entry win, so this test passes
against the pre-fix parser. It is a regression pin, which is fine — but the PR body's
blanket "## Tests (red-first)" over-claims it.

## F4 (cosmetic) — `formatVersions` sorts lexicographically

`native-integrity.ts:194-199`: `.map(v => v.version).sort()` orders `0.10.0` before `0.9.0`.
Message-only, no behavioural impact.

---

## Verified clean (attacked, held)

- **Ordering mechanics.** `Object.entries` preserves insertion order for these
  (non-integer-like) keys, so parse order is deterministic. Bare key `unshift`s to the
  front whether it appears before or after the nested one; a version seen under both keys
  retains the **canonical** record's integrity string (`splice` + `unshift`); the
  `if (entries.length === 0) out.set(name, entries)` line cannot leave an empty array in
  the map (a fresh array always falls through to a push/unshift). No defect found in the
  parser itself.
- **npm aliases.** `"foo": ["foo@npm:sharp@0.35.4", …]` parses to name `foo@npm:sharp`
  (`lastIndexOf("@")`), so `key === name` is false and it is pushed non-canonically.
  Pre-existing name-derivation behaviour, unchanged by this PR, and cannot collide with
  the `@img/*` names the integrity path looks up.
- **Neither-matches error names every pinned version.** `native-integrity.ts:139` uses
  `formatVersions(versions)` — verified it enumerates the whole list. Test 3
  (`native-integrity.test.ts:344-352`) genuinely reds the old code on its **second**
  assertion (old message named only the surviving version); its first assertion (`/0\.36\.0/`)
  would pass either way, so the both-halves coverage rests on the second — it holds.
  Test 1 reds old code; test 2 is a disclosed regression pin.
- **Mutation prover.** All three anchors occur **exactly once** on the branch
  (`if (!versions) {`, the `versions.find(...)` line, `if (existing !== -1 && key !== name) continue;`).
  M7's replacement genuinely collapses the map to one-version-first-wins, which kills both
  the nested-match test and the neither-match test — it reds the OLD behaviour as claimed.
  M3's `?? versions[0]` is a clean tolerance mutation, not a crash.
- **bun-1.3.5 lockfile-rewrite hazard: clean.** `git diff --quiet <base> <head> -- bun.lock
  examples/bun-exec/bun.lock` → IDENTICAL. The PR touches 5 files, none of them a lockfile.
- **Same-class sweep: complete.** `git grep readLockfilePackages` on the branch returns only
  `native-integrity.ts` (definition + its own use) and `vinext-build.ts:52,288,341` — both
  updated. `scripts/mutation-prove-release-lane.mjs:164` anchors on the four-space-indented
  root key, version-safe as the PR claims. `scripts/lib` hits are comments only. No other
  name-only lockfile consumer exists.
