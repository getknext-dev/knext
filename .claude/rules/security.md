# Security invariants (knext)

Complements `.claude/rules/architecture.md`. These run through **every** phase — they are not a
"security milestone" to defer. Several are also enforced deterministically by hooks
(`block-dangerous-bash.sh`, `block-secrets.sh`); the rules here cover the judgment the hooks can't.

## Endpoints & auth
- **No unauthenticated mutating endpoints.** Any route/handler that changes state (cache
  invalidation, deploys, admin actions) must require auth — a signed token and/or an
  internal-only `NetworkPolicy`. **(RESOLVED)** `POST /api/cache/invalidate` and
  `DELETE /api/cache/events` now require a Bearer token (`CACHE_INVALIDATE_TOKEN`, fail-closed);
  see the audit in `docs/security/mutating-endpoints.md`. Defense-in-depth: the operator reconciles a
  default-on internal-only `NetworkPolicy` from the `NextApp` CR (`spec.security.networkPolicy`, #90).
  Do not reintroduce an open mutating route.
- **Backends are cluster-local.** `BackendService` Knative services use
  `networking.knative.dev/visibility: cluster-local` — no public ingress (ADR-0004).
- **Service-to-service authz.** Gateway↔backend calls authenticate (shared signed token → mTLS
  via mesh later). No implicit trust between pods.

## Secrets
- **Secrets live in Kubernetes Secrets / env only** — never in config files, source, container
  images, or URLs. The operator provisions them; the app reads from env.
- Do not echo secrets into logs, manifests, or commit messages. (The `block-secrets` hook blocks
  the obvious cases; you own the rest.)

## Supply chain (the open security milestone)
- **SBOM** per image (e.g. syft) **and per published npm package** (CycloneDX over the
  `@getknext/*` production closure — `scripts/audit-published.mjs`).
- **Scan** every image (Trivy/Grype) **and every published npm tarball** (`npm audit --omit=dev`
  over the packed prod closure); **fail the build on HIGH/CRITICAL**; triage + document accepted
  risk or upgrade. The npm gate is **publish-blocking** (runs `needs`-before the publish job in
  both `release.yml` and `release-ghp.yml`); accepted advisories go in the dated+justified
  `security/npm-audit-allowlist.json` (mirrors the Trivy triage pattern).
- **Sign** images (cosign) + attestation; aim for reproducible builds. **Caveat (ADR-0035, #440):**
  the image-baked V8 compile-cache layer (shared `scripts/warm-compile-cache.sh`, #439) is stable but
  **not bit-reproducible** — across three bakes the entry count was identical (1106) while byte
  totals varied within ~100 (4,246,088 / 4,246,032 / 4,245,984). Any reproducible-builds work MUST
  **exclude or normalise** this layer rather than flag it as a regression; it is a build-time
  optimisation keyed by module filename, not a source artifact.
- Maintain a short **threat model** in `docs/security/`.
- **Pin images by digest; reject `:latest`.** The operator already rejects `:latest`
  (`nextapp_controller.go:66`); fix the remaining placeholder
  (`config/manager/manager.yaml` → `controller:latest`).
- **Pin third-party GitHub Actions by full commit SHA in any workflow where a write-scoped
  credential is in scope** — the same rule as pinning images by digest, applied to CI. A version
  ref is not immutable: `changesets/action@v1` resolves to `refs/heads/v1`, a **branch**
  (`git/ref/tags/v1` 404s), and that ref is handed `NODE_AUTH_TOKEN` — so whoever can move that
  branch runs code with a live npm publish token in scope. Pin as `uses: owner/repo@<40-hex-sha>
  # vX.Y.Z` so the pin stays auditable, and let **Dependabot** (`github-actions` ecosystem) own the
  bumps so pinning does not decay into staleness. Enforced for the publish path by
  `tests/release-action-pins.test.ts`; the remaining workflows are being pinned in blast-radius
  order (cosign/OIDC signing next — those use short-lived keyless tokens, no standing secret).
  **Know what CI does and does not check:** that test asserts *immutability and scope* — a 40-hex
  SHA, an auditable `# vX.Y.Z` comment, and an allowlist of which actions may touch a
  credential-bearing workflow. It deliberately does **not** assert the SHA *value*, because doing so
  reddened every correct Dependabot bump and made editing the guard the routine way to get green.
  So **a SHA that does not belong to its commented tag is caught by human review of the Dependabot
  diff, not by CI** — read the SHA against the tag before approving a bump on the publish path.

## Runtime hardening
- **Reverse proxy** (nginx/Envoy) in front for rate limiting, payload-size limits, and
  malformed-request handling.
- **Graceful shutdown:** on `SIGTERM`, drain in-flight requests and run Next.js `after()`
  callbacks before exit — no dropped requests on scale-down.
- Distroless runtime, non-root, least-privilege ServiceAccounts (operator already sets
  `AutomountServiceAccountToken: false`).

## Git autonomy (project policy)
Agents **may** push feature branches and open PRs autonomously (`git push <branch>`, `gh pr create`)
— this is standing authorization for this project. Still **never** acceptable on the agent's behalf
without explicit human action: **force/mirror/`--all` push**, **direct push to `main`/`master`**, and
**history rewrite** (`filter-branch`, `reset --hard`). The `block-dangerous-bash.sh` hook enforces
this split.

## Hard line
Adding an unauthenticated mutating endpoint, committing a secret, or force-pushing / pushing
directly to `main` on the agent's behalf are **never** acceptable without explicit human action.
When unsure, stop and surface it.
