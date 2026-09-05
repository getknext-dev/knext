# Adversarial code review — PR #956 (node-CLI vinext build fix, closes #948)

Verdict: **ISSUES_FOUND** (4; none are correctness regressions in the shipped fix — 3 weaken the
guard/claims, 1 is a message-quality gap). The core fix is right and empirically confirmed.

## Verified good (attacked, held)

- **Error discrimination is honest.** Probed `execFileSync` on this machine (Node):
  missing binary → `code === "ENOENT"`; non-executable → `"EACCES"`; **non-zero exit → `code`
  is `undefined`, `status === 1`**. So a broken/exploding bun falls to the honest branch and a
  missing one to the install branch. No conflation.
- **Bun 1.3.5 path is honest about the floor.** Detection succeeds, then
  `vinext-build.ts:298` names `1.4.0 or newer; found '1.3.5'` with the 121ms-vs-61ms rationale
  and `bun upgrade`. Not routed through either new message.
- **Static import changes no other path.** `vinext-build.ts` has no importer in the
  adapter/runtime closure — `adapters/artifact-contract.ts` mentions it only in comments. Import
  of `node:child_process` cannot itself fail under Node/Bun.
- **Same-class sweep is clean.** Only live bare-`require` left in `packages/kn-next/src` is
  `adapters/vinext-image-optimizer.ts:118`, which is bound to a local `createRequire(...)` —
  esbuild does not rewrite it to `__require`, and it is not in the CLI bundle closure.
- **Tests do run the bundled bin under Node** (`NODE_BIN` + `dist/cli/kn-next.js`), with a
  from-scratch PATH; a real machine Bun cannot rescue the "absent" case.
- **Guard's regex genuinely detects the defect**: `__require\s*\(\s*["']` matches the pre-fix
  `dist/cli/build.js` in the local tree (`__require("child_process"`). Mutation-proved against the
  real artifact, not a fabricated one.
- Header scope note in `cli-node-runtime.test.ts` is truthful; docs carry no ADR/issue numbers.

## Findings

### 1. Static guard is scoped too tightly, and its comment overclaims — `vinext-build-node-bundle.test.ts:193-205`
The scan is `readdirSync(dist/cli)` top-level, `.js` only. Measured on the local dist:
- the `__require` **definition** lives in `dist/chunk-DGUM43GV.js`, and `dist/cli/build.js`
  imports **8** `../chunk-*.js` files → tsup hoists any module shared by 2+ CLI entries into
  `dist/chunk-*.js`. A lazy `require()` in a shared CLI module (`shared.ts`, `exec.ts`, config
  loading) emits its call site **into a chunk**, which this guard never reads;
- `dist/cli/ci/credential-scope.js` exists and is skipped (no recursion).

The comment claims "the next lazily-required builtin in **ANY** cli module fails here instead of
on a user's machine" — false for exactly the modules most likely to be shared. Fix: walk
`dist/` recursively (or at minimum `dist/cli/**` + `dist/chunk-*.js`).

### 2. Guard has no non-vacuity assertion — same test, `:201-202`
`offenders` stays `[]` and the test is green if zero files were scanned (tsup emitting `.mjs`,
entries relocating). Repo rule "guards must assert both halves": add
`expect(scanned).toBeGreaterThan(0)` (and assert `distBin` exists).

### 3. PR body's red-first claim is wrong for test 2
"All four were red before the fix (three on the mislabel)". Pre-fix, the message was exactly
*"needs `bun` on PATH (https://bun.sh), and it was not found."* — which satisfies every assertion
in *"with NO bun on PATH…"* (contains `bun`, `https://bun.sh`, `/not found/i`, no "Dynamic
require"). That test **passed pre-fix**; it is a regression lock, not red-first. Two behavioral
tests were red, plus the static guard. Correct the claim (repo rule: re-read your claims against
the tree before merging).

### 4. "Underlying error" is a tautology — `vinext-build.ts:410,413`
`execFileSync` **inherits stderr by default**, so `ret.stderr` is null and
`err.message` is just `Command failed: bun --version` — the printed
`Underlying error: …` carries no cause. Verified by probe. The child's stderr does reach the
user's terminal (inheritance), so nothing is lost, but `cli.mdx` promises "stops the build with
that underlying error". Fix: `{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }` so the
cause lands in the message.

## Not defects (checked, dismissed)
- Guard false-positive risk from a legitimate future `__require`: acceptable — under ESM Node the
  shim always throws, so any call site is a real landmine.
- Test 3's whole-output `not.toMatch(/not found/i)` could false-**red** on an unrelated log line;
  fails in the conservative direction.
- Fixture's `{...process.env}` spread: PATH is overridden, so the isolation claim holds.
