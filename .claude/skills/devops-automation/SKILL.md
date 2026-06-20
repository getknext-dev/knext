---
name: devops-automation
description: CI/CD, supply-chain, and release automation for knext — CI gates (Biome lint, vitest, the official Next.js compatibility suite), clean-state verification, SBOM + Trivy/Grype scanning + cosign signing, image digest pinning, and npm/changesets releases. Use when wiring CI, adding a build/test gate, setting up SBOM/scan/sign, debugging clean-checkout CI failures, or preparing a release.
---

# DevOps Automation (knext)

## CI gates (every PR)
Run all from a **clean checkout** (no stale `dist/`/`node_modules`) — clean-state mismatch is a
known false-green trap in this repo:
```bash
pnpm install --frozen-lockfile
pnpm -r build            # build workspace libs first; @knext/lib ships only dist/,
                         # so tests that import it fail on a clean tree if not built
pnpm run lint            # Biome — repo-wide; CI runs `biome check .` (format diffs FAIL)
pnpm exec vitest run --coverage
```
Lessons learned (real CI failures this project hit):
- **`biome check .` fails on format diffs**, not just lint errors — run repo-wide, not scoped.
- **Tests that import `@knext/lib` need it built** (its `exports` map to `dist/`); add a
  vitest `resolve.alias` to `packages/lib/src`, or build lib in `pretest`.
- **Machine-coupled tests** (hardcoded paths, a local `bun`) break in CI → gate them with
  `skipIf(bun-missing || build-absent)`; use `import.meta.dirname`, not absolute paths.

## The correctness gate (north star)
Wire the **official Next.js compatibility suite** into CI on every PR — this is the
verified-adapter credibility lever. No parity claim ships without it green. Publish the
supported/unsupported matrix.

## Supply chain (the open security milestone — see security.md)
On release builds:
1. **SBOM** per image — `syft <image> -o spdx-json`.
2. **Scan** — `trivy image --exit-code 1 --severity HIGH,CRITICAL <image>` (and/or grype). Triage
   + document accepted risk or upgrade + rerun.
3. **Sign** — `cosign sign` + attestation (SBOM/provenance). Aim for reproducible builds.
4. **Pin by digest; reject `:latest`** — the operator already rejects `:latest`
   (`nextapp_controller.go:66`); fix `config/manager/manager.yaml` (`controller:latest`).

## Images
Distroless Node 22 runtime (`apps/file-manager/Dockerfile`): 2-stage — `next build` standalone →
`gcr.io/distroless/nodejs22` running `server.js` with `NODE_COMPILE_CACHE`. **arm64 vs amd64
matters** (Apple Silicon builds arm64; x86 nodes need `--platform linux/amd64` /
`docker buildx`). Build on/for the target arch.

## Deploy automation (ADR-0001)
CI **builds + pushes the image + applies a `NextApp` CR** — it must NOT generate/apply raw
Knative manifests (the operator reconciles). A Vercel-style flow: PR → ephemeral preview
`NextApp` (`minScale:0`, cluster-comment the URL); merge → prod `NextApp`; rollback = Knative
revision traffic split. Auth via OIDC/Workload Identity — **no long-lived keys** in CI secrets.

## Releases
- **changesets** + semver; tag + GitHub release.
- **npm publish** `@…/core` (+ lib) — unblocks `npx kn-next` for outside users (currently
  unpublished; resolve the `@kn-next` vs `@knative-next` scope drift first — see framework-design).
- Versioned docs; dogfood the docs site on knext.

## Don't
- Never `--no-verify` / bypass hooks (superteam discipline) — fix the failing check.
- Never push/force-push on the agent's behalf (the `block-dangerous-bash` hook enforces this).
- Never put secrets in CI files/images — OIDC + K8s Secrets only.
