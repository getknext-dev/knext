# System-Designer sign-off — PR #890 (vinext-only builder)

## Verdict: BLOCK

### Blocking: the build→deploy asset contract was not moved with the builder
`packages/kn-next/src/utils/asset-upload.ts:509 stageStandaloneAssets()` is still bound to the
retired standalone tree, and it is called unconditionally whenever `hasStorage(config)` from BOTH
`cli/build.ts:171` and `cli/deploy.ts:492`. No shape awareness anywhere in that file (0 hits for
`nitro-output-bun`).

Under the new default (`build: vinext`, shape `nitro-output-bun`) the only served asset root is
`.output/public` (`templates/app/Dockerfile.hbs:38 COPY .output/public …`;
`optional-storage.test.ts:316-337` pins that `.next/static` and `.next/standalone` are the paths
"this build never produces"; `examples/bun-exec/README.md:50` — routes are in the binary,
`.output/public` is read from disk). Consequences:

1. **Normal case — hard failure on the default path.** `.next/static` absent →
   `stageStandaloneAssets` throws *"No .next/static directory found … run `next build` (with
   output: 'standalone')"*. Every storage-configured app now fails `kn-next build` and
   `kn-next deploy`, with remediation naming the builder this PR retired.
2. **Mixed-tree case — silent artifact destruction.** If a stale `.next/static` exists, line 522
   `rmSync(stagingDir /* = .output/public */, {recursive:true, force:true})` **deletes the vinext
   build's real static root** and refills it from the standalone tree — and in `deploy` this runs
   *concurrently* with the docker build that COPYs `.output/public` (deploy.ts:481-497 parallel
   tasks). Nondeterministic image contents; the pod 404s its own chunks.
3. Collateral: the skew-protection marker keys off `.next/BUILD_ID` (asset-upload.ts:543), which
   vinext does not emit → `_next/static/<buildId>/` namespacing and `kn-next gc` lose their key.

**Smallest fix (either):**
- Make staging shape-aware: for `nitro-output-bun`, source from `.output/public` and stage into a
  dir that is NOT the shipped artifact (e.g. `.knext-upload/`) — never `rmSync` the artifact root;
  derive the build id from the vinext output rather than `.next/BUILD_ID`. Add one test:
  `hasStorage` × `nitro-output-bun`.
- Or, if the decision is "the vinext image serves its own statics", make `storage` + vinext an
  explicit validator refusal with a migration message, and say so in the docs — not an ENOENT-shaped
  throw discovered at deploy.

## Non-blocking findings
- **RuntimeContract is now app-owned with no verification.** Health `/api/health` (operator
  readiness+liveness, `readinessProbePath` default), `:9091` metrics and the SIGTERM drain live in
  the scaffolded `knext-bun-entry.mjs`; `buildVinextExecutable` compiles `.output/server/index.mjs`
  whatever it contains. A vinext app that does not use knext's nitro entry compiles and deploys and
  simply never drains / never exposes metrics / never goes Ready. No post-compile smoke asserts the
  binary prints `LISTENING:<port> METRICS:<port>`.
- **New CRD + old operator pod** (CRD rolled first): a config with the previously-recommended
  `runtime: "bun"` now also emits `build: "vinext"`; the old controller still forces
  `bun run server.js` → CrashLoop until the operator pod rolls. Self-healing, but the CLI could
  simply refuse to emit `runtime` for the vinext shape (it is meaningless there) and close it.
- Old CRD + new CLI is genuinely safe, incl. GitOps: an invalid *enum value* on a known field is
  rejected by apiserver schema validation regardless of `--validate` mode. Good.
- **No arm64 path.** `build.ts` hardcodes `arch:"linux-x64"` with no flag, though `COMPILE_TARGETS`
  has `linux-arm64` and deploy pins `--platform linux/amd64`.
- **Stale-binary hazard.** `deploy` docker-builds the app Dockerfile which COPYs
  `knext-exec-linux-x64` from the context; a leftover binary from an earlier build ships silently —
  nothing ties the binary to this build.
- **Consumer Bun requirement.** `kn-next build` now hard-requires `bun` on PATH; CLAUDE.md §9 still
  claims Bun is a contributor-only concern (install-smoke only exercises `--help`).
- **Stale references to the deleted pass:** `README.md`, `docs/ARCHITECTURE.md` still document
  `KNEXT_BUN_BYTECODE`.
- scs-zones / security: no zone-DB access, no new mutating endpoint, no secret handling change,
  digest pinning untouched. Clean.

## Failure mode the tests do not cover
`hasStorage(config)` × `shape === "nitro-output-bun"` — there is no test anywhere that runs the
upload path against a vinext artifact, which is why both the throw and the `rmSync`-over-the-
artifact race went unnoticed.
