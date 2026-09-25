# TypeScript 7 migration — hand-off

PR: https://github.com/getknext-dev/knext/pull/1408
Branch: `spike/1402-typescript-7`
Tip: `c4157578` (round 3, all four review items fixed)

## State: open, ready for review, not yet merged

## What landed
- **Monorepo's own toolchain**: `tsc` typechecking runs on TS7 (native compiler, ~5x faster) via
  a `typescript-tsc7` alias (`npm:typescript@^7.0.2`), invoked explicitly by every root and
  per-package `typecheck` script (root, `lib`, `db`, `kn-next`, `ui`, `db-demo`, `file-manager` —
  7 total). The plain `typescript` devDependency stays a unified `^5.9.3` everywhere — `tsup`'s
  DTS bundling (`rollup-plugin-dts`) needs the classic compiler API (`ts.sys` etc.), which TS7's
  default export doesn't ship.
- **Scaffolded user apps stay on `typescript@^5.9.3` by default.** The only verified, real reason:
  TS7 ships no `tsserver.js` (the protocol VS Code's "use workspace version" speaks). TS7 does
  have an LSP (`tsc --lsp --stdio`, verified to answer JSON-RPC), just a different protocol editors
  don't auto-negotiate. Two claims that were checked and found FALSE, so don't resurrect them:
  eslint/`typescript-eslint` incompatibility (none of the 3 templates ships eslint at all — no
  lint script, no `eslint-config-next`), and `next build`'s own typecheck needing the classic API
  (verified directly: a TS7-swapped scaffold's `next build` succeeds clean, 0 errors).
  Documented at `apps/docs/content/docs/typescript.mdx`.
- **Guards, all mutation-proved:**
  - `tests/typecheck-scripts-use-tsc7.test.ts` — every workspace `typecheck` script that invokes
    `tsc` at all must do so via `typescript-tsc7`. Added in round 3 because nothing else caught a
    plain-`tsc` regression on root/lib/kn-next (full suite stayed green with the binary swapped
    back — only speed was lost, and nothing asserted speed).
  - `tests/template-typescript-pin.test.ts` — scaffold templates track the workspace `typescript`
    pin (same pattern as `template-next-pin.test.ts`/`template-sharp-pin.test.ts`), plus a
    dedicated "workspace default is not `^7`" assertion.
  - `tests/root-typecheck-gate.test.ts` — its `--showConfig` check now resolves against
    `typescript-tsc7` (the binary the real gate runs), not plain `typescript`.
- **Real TS7 differences found and fixed** while wiring per-package typechecks onto the TS7
  binary (beyond what any review round asked for):
  - TS7 doesn't auto-include `@types/*` the way 5.x/6.x does — `bun:test`'s ambient module (from
    `@types/bun`) 404s without an explicit `types: ["bun"]`. Fixed in
    `packages/{lib,db}/tsconfig.typecheck.json`, `packages/ui/tsconfig.json`,
    `apps/db-demo/tsconfig.json`.
  - TS7 enforces `rootDir` even under `noEmit`, where 5.x/6.x didn't. Fixed by widening `rootDir`
    to the repo root in `packages/{lib,db}/tsconfig.typecheck.json` (legitimate cross-package test
    imports; nothing is emitted from either config anyway).
- Changeset: `.changeset/typescript-7-tsc-speedup.md` (`@getknext/core`).

## Methodology lesson baked into the commits (don't repeat)
Never manually place a package version into `node_modules` to probe API surface, then trust a
subsequent `bun install` cleaned it up — bun does not clobber an existing non-symlink directory it
thinks is already installed. This produced two false-green verifications in earlier rounds (tsup
DTS looked fine, wasn't; a `bun:test`/`rootDir` regression class was invisible until a genuinely
clean install + `turbo build --force` was run). Always verify from a fresh `bun install` after any
manual `node_modules` poking, and check the resolved binary's own `--version`/`package.json`, not
just that the command succeeded.

## Three review rounds, what each found
1. Round 1 (initial): pinned `typescript@^7` everywhere, added a `typescript-api` alias for 11
   AST-walking call sites, added scaffold-template TS7 pins. Merged with origin/main (#1386) along
   the way.
2. Round 2 ISSUES_FOUND: scaffold default should stay 5.9 (eslint/tsserver claims, later found
   partly wrong — see round 3), needed a changeset + accurate PR body, the `typescript-api` alias
   was questioned, and per-package CI typechecks needed to actually run on TS7 (they didn't — only
   root did). Fixing that surfaced the `@types/bun`/`rootDir` TS7 differences above. Dropped
   `typescript-api` entirely (jev 0.73) since it was functionally redundant once workspace
   `typescript` reverted to 5.9.3.
3. Round 3 ISSUES_FOUND (this hand-off's work): the eslint claim was fabricated (jev 0.89 from the
   coordinator, confirmed false) — verified directly no template ships eslint, and separately
   verified `next build`'s typecheck genuinely works under TS7 (disproving the original hypothesis
   for WHY the scaffold stays on 5.9). The editor claim was overstated (TS7 does have an LSP).
   Added the tsc7-binary guard test. Fixed a PR-body count/wording nit.

## If a round 4 comes back
- Don't re-litigate the tsserver.js rationale — it's the one claim in this whole doc verified
  directly and correctly on the first try (checked `node_modules/typescript/bin` for `tsserver*`,
  confirmed absent).
- If asked to extend TS7 further (e.g. make it the scaffold default outright), that's a founder
  call per the coordinator's round-2 message ("that's my decision for tonight; I'll flag it to the
  founder, who asked for TS7 and can override") — don't make that call unilaterally.
- `.claude/research/ts7-migration-plan.md` (the original spike doc) has more detail and its own
  correction note from round 1; it wasn't touched in rounds 2-3 and may be slightly behind this
  hand-off's rationale (the eslint/editor corrections from round 3 aren't reflected there) — treat
  this hand-off and the PR body as the current source of truth over that file if they conflict.

## Not done / not investigated
- `tests/scaffold-pack-contents.test.ts` has a 5000ms bun-test default timeout around a real
  `npm pack --dry-run` subprocess call, which times out under concurrent full-suite load on a
  loaded shared host (observed load average 82-141 from other agents). Confirmed unrelated to this
  PR (passes standalone every time, including under elevated load) and pre-existing — not fixed,
  out of scope for #1402/#1408. Worth a separate issue if it keeps flaking in CI: either raise the
  test's own timeout or serialize/isolate it from concurrent runs.
