# PR #958 round-2 verification re-review — ISSUES_FOUND (2 findings, 1 blocking-class)

Scope: `043d7647` (the round-2 commit after `bb176aca`) + regression risk.
Method: shared clone at `/tmp/rev958/knext`, bun 1.4.0 (mise), `lib`/`db`/`core` built.
Everything below is **measured**, not read.

## Verdict

**ISSUES_FOUND.** All eight of the lead's checklist items hold (details below), the suite and
typecheck claims reproduce exactly, and every requested mutation is KILLED. Two defects the
round-2 commit *introduced* survived both reviews:

- **I1 (medium)** — a build that fails part-way through staging wedges every subsequent build
  behind a refusal whose message is false.
- **I2 (low)** — `sharp-addon-dlopen.test.ts` was re-encoded double-UTF-8 in this commit.

---

## I1 — a mid-staging failure leaves an unmarked `native/`, and the next build refuses forever

`packages/kn-next/src/cli/vinext-build.ts:282` (`clearStagedNative(dest)`),
`:300-309` (copy, then `continue`), `:318/:325/:333` (the throws), `:407` (the refusal),
`:343` (`writeNativeIntegrityManifest`, only reached on full success).

The manifest is written **once, after the whole loop**. Any throw between the first successful
`copySync`/fetch and the end of the loop leaves `native/` **with content and no
`.integrity.json`** — precisely the state `clearStagedNative` is built to refuse. So the *next*
build dies at `:407` with:

> Refusing to stage into …/native: it has content but no .integrity.json, so knext did not stage it.
> … this tree was not written by knext, and deleting it could destroy your files.

which is **false** — knext wrote it — and the build stays wedged until the user manually deletes
a directory the message just told them was theirs.

**Measured** (probe, scratch clone), first package staged, second `fetchPackage` throws:

```
build 1 failed: network down fetching @img/sharp-libvips-linuxmusl-x64
native/ after failure: [ "sharp-linuxmusl-x64" ]
build 2 message: Refusing to stage into /var/.../native: it has content but no
                 .integrity.json, so knext did not stage it.
```

Reachability is not network-only. The same residue follows from the offline paths: host has
`@img/sharp-<id>` but not the `libvips` half and the lockfile lacks it (`:325`), or the tarball
sha512 mismatches. The default fetch shells out to `npm pack` (the PR says so), so one transient
registry blip converts a retryable build into a manual-intervention build.

**This is a round-2 regression.** Round 1's unconditional `rmSync(dest)` self-healed the residue;
the ownership marker is a real improvement, but it was added without making staging atomic.

Fix shapes (any one): stage into a temp dir and rename on success; wrap the staging body so a
throw removes only what this run created; or write the marker before staging and treat a
knext-shaped tree (only `sharp-*` entries) as knext's own.

## I2 — `sharp-addon-dlopen.test.ts` re-encoded double-UTF-8 by this commit

`packages/kn-next/src/__tests__/sharp-addon-dlopen.test.ts` — first at `:8`, 24 sites.

Byte-level comparison of every file in `bb176aca..043d7647`; this file is the **only** one
affected, and it was clean at the base:

| | base `bb176aca` | head `043d7647` |
|---|---|---|
| `—` double-encoded (`c3a2 c280 c294`) | 0 | **19** |
| `—` correct (`e2 80 94`) | 20 | 1 |
| `→` double-encoded | 0 | **2** |
| `…` double-encoded | 0 | **3** |

Comments, test names, and one assertion message (`:153`, the dist-missing hint). Cosmetic, but it
is an unintended whole-file re-encode that will corrupt further on the next edit and pollutes
every future diff of the file. Every other touched file (`vinext-build.ts`, the shim, both other
test files, the helper, the mdx) gained correctly-encoded em-dashes — so it is this file only.

---

## What holds — measured

**M1 native/ safety** — all three behaviours confirmed by probe:
(a) user content + no manifest → named refusal, `my-addon.node` intact after the throw;
(b) manifest present + unlisted `NOTES.txt` beside it → prune removes only manifest-listed
entries, `NOTES.txt` survives;
(c) **escaping keys are skipped** — a manifest listing `../VICTIM.txt`, an absolute path outside
the tree, and `..` deleted nothing: `VICTIM exists: true`, `ABS VICTIM exists: true`,
`outside dir exists: true`, and the unlisted `native/keepme.txt` survived.

**Mutations** (anchor-asserting python script, never perl; baseline and restored tree both green):

| mutation | result |
|---|---|
| `clearStagedNative` → `rmSync(dest)` unconditionally (true removal of the guard) | **KILLED** (both M1 tests red) |
| `appUsesSharp` loses the package.json signal | **KILLED** (declared-but-unfindable test red) |
| `appUsesSharp` loses the lockfile signal | **KILLED** (hidden-layout fetch test red) |
| app template `sharp` → `^0.36.0` | **KILLED** (M3 ceiling) |
| **zone** template `sharp` → `^0.34.0` | **KILLED** (F1, the round-1 survivor) |

One nuance worth stating: the *narrow* mutation `if (!existsSync(manifestPath))` → `if (false)`
**SURVIVED** — but not as decoration. With that branch gone, `readFileSync` on the absent manifest
throws ENOENT into the adjacent catch, which raises the *other* refusal, still naming
`.integrity.json` and still deleting nothing. The user-visible behaviour is unchanged, so the test
is right to stay green; the behaviour-level mutation above is the valid proof and it is KILLED.

**M2** — lockfile-only pnpm-shaped tree → pinned fetch of exactly the two packages;
declared-but-unfindable → named throw with **no `.integrity.json` written** (asserted).
An app with **no** sharp anywhere (no `@img`, no lockfile, `package.json` without sharp) still
skips cleanly: no fetch, empty manifest `{}`.
*Note, not a finding:* `findLockfile` walks to the filesystem root, so inside a monorepo whose
root `bun.lock` resolves any `@img/*`, a member app that does not use sharp reads as using it —
degrading to an unnecessary staged pair (or a hard failure if that lockfile lacks the target
platform). Out of scope for a scaffolded standalone app; flagged only so it is not a surprise.

**M3** `PROVEN_MINOR === 35` — floor and ceiling both asserted, mutation-proved above.

**F1** `tests/template-sharp-pin.test.ts` scans `templates/**` through the shared
`templateManifests()` helper; the zone-template mutation reds. `template-next-pin.test.ts` imports
the same helper (local walk deleted) and is green.

**F2** #959 is OPEN, carries AC4 verbatim *and* the negative control ("prove the check can red …
against an image staged with a foreign-platform-only `native/`"); PR body links it and says
`Closes #949` stands.

**Nits** — shim docstring boot-cost claim corrected (static import → boot, S3-V);
`dist ships the verbatim source copy, byte-equal` green; `sharp-addon-dlopen.test.ts` is **absent**
from `tests/scratch-space-exceptions.json` and `tests/temp-dirs-outside-the-repo.test.ts` is
29/29 green (zero leaks); `templates/app/Dockerfile.hbs` carries no `#949`.

**Regression skim / claims** — full suite `node scripts/bun-test.mjs`: **all 353 test files green,
exit 0**. Root typecheck 0, `packages/kn-next` typecheck 0. The removed
injection-filter assertions in `sharp-addon-dlopen.test.ts` are not lost — they moved verbatim
into `template-sharp-pin.test.ts` (`the compile filter still matches the proven dist/ layout`).

**Flagged flake** — `cache-handler-chaos.test.ts` run 3× in isolation: exit 0 / 4 pass each time.
Did not reproduce here; pre-existing determination unchanged, not a blocker for this PR.
