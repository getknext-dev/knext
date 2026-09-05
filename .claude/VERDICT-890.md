# Architect sign-off — PR #890 (vinext-only builder; ADR-0048 items 3+4)

**Verdict: SIGN-OFF** (non-blocking findings below; #1 should be fixed in this PR).

## What I verified (not took on trust)
- **ADR-0001 intact.** No new cluster writer. CLI still emits only the NextApp CR
  (cr-builder -> deploy/preview apply); build.ts compiles a binary, emits no manifests.
- **"Same change" contract honoured.** Enum widen (nextapp_types.go + regenerated CRD yaml),
  controller branch (`Spec.Build != "vinext" && Spec.Runtime == "bun"`, nextapp_controller.go:1000),
  table test, and tests/adr-state-claims.test.ts pinning BOTH halves are all in THIS diff.
- **No other shape-sensitive operator path.** Grep of the controller package: the container command
  is the only consumer of Runtime/Build. Prewarm DaemonSet execs a copied busybox (image-agnostic);
  no NODE_COMPILE_CACHE injection; probes are HTTP.
- **#548 is loud, as claimed.** preflight.ts:92-97 does `--dry-run=server --validate=strict` of the
  real CR before any cluster write; an old CRD's enum rejects `vinext` server-side (enum validation
  is not affected by `--validate=ignore`), so the GitOps caveat does not silently apply here.
- **skipViteBuild is sound.** vinext-build.ts keeps the `.output/server/index.mjs` existence check
  outside the skipped branch, so `--skip-next` fails loudly instead of compiling nothing.
- **No dangling code references** to the deleted pass (only a stale local coverage artifact).
- **ADR claims check out against the tree:** apps/file-manager/Dockerfile is the compiled binary
  (`CMD ["/app/server"]`, @img staged for dlopen) and ci.yml `prod-image-optimization` probes
  /_next/image strictly against that image; vinext-build.ts really does refuse Bun < 1.4.0.

## Non-blocking findings
1. **README.md:164 is now false** — still documents the per-file bytecode pass and
   `KNEXT_BUN_BYTECODE=0`, which this PR deletes. Workflow step 5 (docs are delivery). Fix here.
2. **docs/compat-matrix.md carries no target caveat** — zero mention of vinext/ADR-0048, so the SSOT
   compat doc's green rows attest to a target users can no longer select. ADR-0048 item 6 already
   tracks this as OPEN, so not a new contradiction; it needs a header caveat soon.
3. **CR asserts artifact shape from CONFIG, not from the artifact.** `deploy --skip-build` on an
   older standalone image with `runtime: "bun"` now emits `build: "vinext"`, the operator drops the
   forced `bun run server.js`, and the image runs its own CMD. Loud (FATAL/CrashLoop) but a
   regression path with no escape hatch — `build: "turbopack"` is validator-rejected, so an existing
   standalone deployment cannot be re-deployed correctly by the new CLI at all. Priced by ADR-0048's
   migration burden, but the retirement message should say "port to vinext" explicitly.
4. **Supply-chain scope moved without its gate.** `kn-next build` now compiles USER apps into a
   binary opaque to Trivy/syft; ADR-0042 C6's closure gate covers only examples/bun-exec in CI (the
   ci.yml comment says so). Recommend the CLI emit/require a pre-compile closure SBOM.
5. ci.yml:747 comment ("the Dockerfile runs `node -e require('sharp')`") is stale for the binary image.

## ADR follow-up
Amend **ADR-0042 Consequence 6** to cover user-app closures (finding 4), and close **ADR-0048 item 6**
with a compat-matrix target caveat (finding 2). Item 7 (maintainer amends architecture.md) stays owed.
