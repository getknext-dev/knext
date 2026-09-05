# Spec review — PR #958 vs issue #949

Verdict: **ISSUES_FOUND** (2 must-fix, 2 informational). Reviewer: spec gate, 2026-09-05.
Subject: `agent/s3-darwin-sharp` (base `agent/s2-tail`), commits `8959ac56`, `bb176aca`.

## Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Staging follows the image target, fetch-or-fail, never host addons | **MET** |
| 2 | Shim selects by runtime platform/libc, not readdir order; named errors | **MET** |
| 3 | Injection filter covers the range the scaffold/**templates** allow | **PARTIAL** — see F1 |
| 4 | End-to-end: non-Linux host build → run image → `/_next/image` bytes | **NOT CLAIMED** — see F2 |

### AC1 — met
`compileVinext` calls `stageSharpNative(opts.cwd, { arch })` with the *compiled* arch
(`vinext-build.ts:211`). `SHARP_PLATFORM_IDS` (`:226`) maps knext archs → `linuxmusl`; unknown arch
is a named refusal (`:276`), and the test scans the key set out of `compileArgv`'s own refusal
message rather than enumerating it. `native/` is cleared before staging (`:281`); a missing pin
fails naming `@img/sharp-<id>`; fetch is `npm pack` + sha512 verified against the lockfile integrity
*before* extraction (`:362-417`), refusing an entry with no `sha512-` integrity. Temp dirs removed in
`finally`.

### AC2 — met, red-first proved
`addonPath()` now iterates `runtimePlatformIds()` (platform/arch, musl via `process.report` glibc
marker + alpine fs fallback, exact libc first) and throws a named error listing wanted vs staged
plus the `KNEXT_SHARP_ADDON` escape hatch when a tree holds only foreign addons.

Proof run (detached worktree, symlinked `node_modules`, `bun test`):

- new shim: 19 pass / 1 fail — the single failure is `dist ships the verbatim source copy`, an
  environmental miss (no built `dist/` in a fresh worktree), not a PR defect.
- **old shim (`agent/s2-tail` file swapped in): 3 additional tests red**, exit 1 —
  `#949 picks this host's addon over an alien one that sorts first`,
  `#949 FAILS LOUDLY, naming platforms…`, and the restated-rule anchor test.
  So the two shipped-shim subprocess guards are genuinely red-if-deleted.

## Findings

### F1 (must fix) — the C-1b coupling guard covers one of the two template trees
`sharp-addon-dlopen.test.ts:180` reads a single path,
`packages/kn-next/templates/app/package.json.hbs`. Mutation-proved both ways:

- app template pin → `^0.34.0`: the `#949 … injection filter is PROVEN` test goes **red**. Good.
- `turbo/generators/templates/zone/package.json.hbs` pin → `^0.34.0`: **nothing in the suite goes
  red** (shim suite fails only on the pre-existing dist test; `tests/template-next-pin.test.ts`
  exits 0 — it pins `next`, not `sharp`). Grep confirms the app-template read is the only `sharp`
  pin assertion in the whole test tree.

The zone template statically imports sharp (`knext-bun-entry.mjs.hbs:85`) and is compiled through
the same `vinext-compile` `onLoad` injection, so #949's "no silent no-injection path" is still
reachable through it. AC3's wording is "the scaffold/**templates** allow". Fix is cheap and matches
the repo's own "prefer scanning to enumerating": scan every `templates/**/package.json(.hbs)` — the
helper already exists (`tests/helpers/workspace-manifests.ts`, used by `template-next-pin.test.ts`).

### F2 (must fix, hygiene) — `Closes #949` with AC4 disclaimed
The body honestly states AC4 is not delivered, but `Closes #949` auto-closes the issue on merge and
the e2e criterion is then untracked. Use `Refs #949`, or keep `Closes` only once a follow-up issue
for the e2e/CI lane is filed and linked.

### F3 (minor) — no upgrade note for already-built macOS images
An image built by the *old* CLI has the old shim baked into the binary, so it keeps crash-looping
until rebuilt; `image-optimization.mdx` describes the new behaviour but never tells that user to
rebuild. One sentence closes it. (Docs otherwise clean: no ADR/issue numbers in the mdx; the `#949`
in `Dockerfile.hbs` matches long-standing precedent in the shipped templates.)

### F4 (informational) — staging red-first is an import error, not a behavioural red
New `vinext-build.test.ts` against the old `vinext-build.ts` fails at import (`SHARP_PLATFORM_IDS`
/ the `arch` option did not exist), so the "old code staged the host set" claim is red by API
absence rather than by behaviour. Structurally unavoidable. The behavioural half is separately
mutation-proved: deleting the single `rmSync(dest, …)` anchor reds
`a rebuild CLEARS a previous build's foreign addons out of native/` and nothing else.

## Coverage of the other trees (scanned, not enumerated)
`apps/docs/Dockerfile` and `apps/file-manager/Dockerfile` stage `@img` themselves inside the *Linux*
builder, so host platform never applied there; file-manager copies the whole `@img` tree, which the
new runtime-platform selection now disambiguates correctly. The zone template has no Dockerfile by
design (`create-scaffold-parity.test.ts` CLI_ONLY). Staging is CLI-side and shared, so both template
trees inherit the fix.
