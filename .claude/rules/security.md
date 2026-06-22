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
- **SBOM** per image (e.g. syft).
- **Scan** every image (Trivy/Grype); **fail the build on HIGH/CRITICAL**; triage + document
  accepted risk or upgrade.
- **Sign** images (cosign) + attestation; aim for reproducible builds.
- Maintain a short **threat model** in `docs/security/`.
- **Pin images by digest; reject `:latest`.** The operator already rejects `:latest`
  (`nextapp_controller.go:66`); fix the remaining placeholder
  (`config/manager/manager.yaml` → `controller:latest`).

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
