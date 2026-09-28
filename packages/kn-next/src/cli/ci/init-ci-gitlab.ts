/**
 * `knext init-ci --provider gitlab` (#1534) — the GitLab CI/CD counterpart of
 * `renderWorkflow` (init-ci.ts, the GitHub Actions template). Same base as
 * ADR-0049 stage 1: knext hosts nothing, holds no credentials, and the
 * generated pipeline writes ONE kind of object to the cluster via `kn-next
 * deploy` — nothing here re-derives that.
 *
 * ## Same preflight, reused rather than re-derived
 *
 * The two refusals `packages/kn-next-action` runs before any cluster call
 * are exposed as CLI verbs so a non-GitHub pipeline can invoke them without a
 * shell script re-deriving the rules:
 *
 *   1. `knext doctor --ci-kubeconfig <path>` — the ADR-0061 exec/auth-provider
 *      refusal (`kubeconfig-safety.ts`), a LOCAL file read, no cluster call.
 *   2. `knext ci-preflight --namespace <ns>` — the ADR-0049/#1495
 *      rules-review + hazard spot-check (`credential-scope.ts`), the CLI
 *      verb `ci-preflight-cmd.ts` exposes so this template (and any future
 *      non-GitHub provider) can run the SAME check `kn-next-action`'s
 *      `preflight.mjs` runs, through the published CLI instead of a copy.
 *
 * Both run in their own `preflight` stage, `credential-preflight` declared
 * `needs: [kubeconfig-check]` so the exec-plugin refusal always completes
 * BEFORE `ci-preflight` ever shells out to kubectl — mirroring
 * `kn-next-action/action.yml`'s step order. `deploy` needs both. Neither
 * preflight job sets `allow_failure` — GitLab's default (a job failure fails
 * the pipeline) is exactly "not skippable", so nothing here may set it `true`.
 *
 * ## Round 2 (#1588) fixes
 *
 *   - `deploy` now actually CAN build and push: `kn-next deploy` shells out to
 *     `docker buildx build … --push` (`deploy.ts`), and a plain `image: node:22`
 *     job has no docker daemon at all. This template pairs a docker-in-docker
 *     service with a docker-CLI-capable job image (`node:22-alpine` + `apk add
 *     docker-cli` — the same digest this repo's own Dockerfiles already pin),
 *     following GitLab's own docker-in-docker recipe
 *     (https://docs.gitlab.com/ci/docker/using_docker_build/#use-docker-in-docker),
 *     and logs into the registry with `KNEXT_REGISTRY_TOKEN` via
 *     `--password-stdin` — never an argv password (`ps` on the runner can read
 *     another process's argv).
 *   - The kubeconfig is written under `umask 077` to a job-scoped path in
 *     `/tmp` (never `$CI_PROJECT_DIR`, which can outlive the job on a
 *     shell/persistent-volume executor) and removed by `after_script`, which
 *     GitLab runs even when the job fails.
 *   - `kubectl` is pinned to an exact release (not whatever `stable.txt`
 *     resolves to today) and its download is checked against the sha256
 *     Kubernetes' own release infra publishes alongside the binary — the same
 *     verification method https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/
 *     documents. That is TOFU against `dl.k8s.io`, the same trust root as the
 *     binary itself, not an independently-sourced hash — recorded here rather
 *     than left implicit.
 *
 * ## Round 3 (#1588) fixes
 *
 *   - **`docker-cli` alone was not enough.** On Alpine, `docker-cli` ships only
 *     `/usr/bin/docker` — the `buildx` plugin is a SEPARATE package,
 *     `docker-cli-buildx` (no `install_if`, `docker-cli` does not depend on
 *     it). `kn-next deploy` runs `docker buildx build` (`runtime-image.ts`'s
 *     `dockerBuildxArgs`, argv[0..1] = `["docker", "buildx"]`), so the `deploy`
 *     job now installs BOTH packages.
 *   - **`kubectl`'s sha256 is now embedded, not fetched.** The old two-`curl`
 *     shape downloaded the binary AND its checksum from the same host
 *     (`dl.k8s.io`) — that catches a corrupted download but not a substituted
 *     one, since there is nothing independent to compare against. The literal
 *     below closes that: it was read directly from
 *     `https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256`
 *     and must move in lockstep with `KUBECTL_VERSION` — bump both together,
 *     never one without the other.
 *   - **The `docker:27.3.1-dind` service is now digest-pinned**, matching the
 *     three job images (`security.md`: pin images by digest, reject mutable
 *     tags). Resolved with `crane digest docker:27.3.1-dind` — the manifest
 *     LIST digest (same convention as the `node:22-alpine` pin above: an OCI
 *     index, not one platform's manifest), so Docker still selects the
 *     runner's actual architecture.
 */
import { cliVersion } from "../create";
import { REQUIRED_SECRETS } from "./ci-secrets";

/** Where the generated pipeline lands, relative to the repo root. */
export const GITLAB_CI_PATH = ".gitlab-ci.yml";

/** Exact kubectl release the generated pipeline installs when the runner has
 * none — pinned, not `stable.txt`, and verified against the sha256 the
 * release publishes alongside the binary. Bump deliberately, not silently. */
const KUBECTL_VERSION = "v1.33.3";

/**
 * sha256 of the `linux/amd64` kubectl binary for {@link KUBECTL_VERSION},
 * read directly from
 * `https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256`
 * (2026-09-28) and embedded here rather than fetched at pipeline run time —
 * the old two-`curl` shape downloaded the checksum from the same host as the
 * binary, which catches corruption but not substitution, since there was
 * nothing independent to compare against. MUST move in lockstep with
 * {@link KUBECTL_VERSION}: bumping one without the other pins a binary
 * against the wrong release's checksum.
 */
const KUBECTL_SHA256_LINUX_AMD64 =
    "2fcf65c64f352742dc253a25a7c95617c2aba79843d1b74e585c69fe4884afb0";

/**
 * `docker:27.3.1-dind`'s manifest-LIST digest (an OCI image index, same
 * convention as the `node:22-alpine` pin below — not one platform's manifest
 * digest, so Docker still resolves the runner's actual architecture),
 * resolved with `crane digest docker:27.3.1-dind` (2026-09-28). Digest-pinned
 * per `security.md` ("pin images by digest; reject `:latest`" — the same
 * rule applies to any mutable tag, and this is a privileged dind service
 * holding the registry token and the decoded kubeconfig for its job's
 * lifetime).
 */
const DIND_DIGEST =
    "sha256:6ca9a6811085e2cf769cbac04bc47daf66629102990391caab7cf37426e939da";

/**
 * The pipeline. `appDir` is baked in at generation time (like `renderWorkflow`'s
 * `working-directory`); the CLI invocation itself is a CI/CD variable
 * (`KNEXT_CLI`) so it can be overridden — e.g. by this repo's own dogfooding
 * pipeline, or by a hermetic test — the same seam `kn-next-action`'s `cli`
 * input gives the GitHub template.
 */
export function renderGitlabPipeline(appDir: string): string {
    const varDocs = REQUIRED_SECRETS.map(
        (s) =>
            `#   ${s.name.padEnd(21)} ${s.what}\n#   ${" ".repeat(21)} ${s.why}`,
    ).join("\n");
    const pinnedCli = `npx --yes @getknext/core@${cliVersion()}`;

    return `# Generated by \`knext init-ci --provider gitlab\`.
#
# Deploys this repository to YOUR cluster on YOUR cloud. knext hosts nothing
# and holds no credentials — every job below runs on your own GitLab Runner,
# against a cluster you control.
#
# CI/CD variables this needs (Settings -> CI/CD -> Variables). Mark EVERY one
# Protected (only available to jobs running on protected branches/tags — this
# pipeline only runs on \`main\`, which you should protect). Mark it Masked too
# EXCEPT where the value is under 8 characters — GitLab refuses to save a
# Masked variable shorter than that (a namespace like \`prod\` or \`default\`
# cannot be Masked; it can still be Protected):
${varDocs}
#
# KNEXT_REGISTRY_USERNAME (optional) — the registry login username. Defaults
# to \`gitlab-ci-token\`, correct for GitLab's own Container Registry; set it
# explicitly for GHCR, Docker Hub, or any other external registry.
#
# KNEXT_KUBECONFIG is a base64-encoded TEXT variable (type "Variable", not
# "File") — the exact same value \`kn-next init-ci --push-secret\` and the
# mint recipe below produce for the GitHub template, decoded the same way.
# The kubeconfig must belong to the ServiceAccount in knext-ci-rbac.yaml. The
# preflight jobs below REFUSE an over-broad credential rather than using it,
# so a cluster-admin kubeconfig fails on the Role to apply instead — same
# refusal, same message, as the GitHub Action.

stages:
  - preflight
  - deploy

variables:
  # Override to point at a different CLI invocation (a local checkout's
  # built dist, a pinned alternate version, …) without editing every job.
  KNEXT_CLI: "${pinnedCli}"

# The kubeconfig lives under /tmp for the lifetime of ONE job — never under
# $CI_PROJECT_DIR, which a shell or persistent-volume executor can leave on
# disk after the job ends. \`\${CI_JOB_ID:-$$}\` falls back to the shell's own
# PID only when CI_JOB_ID is unset (i.e. outside a real GitLab job, such as a
# hermetic test harness) — on a real runner CI_JOB_ID is always set, so the
# fallback never fires there, and \`after_script\` (a separate shell context)
# resolves the exact same path because CI_JOB_ID is a predefined variable
# available in every phase of the job.
.knext_kubeconfig: &knext_kubeconfig
  - umask 077
  - export KUBECONFIG="/tmp/knext-kubeconfig-\${CI_JOB_ID:-$$}"
  - printf '%s' "$KNEXT_KUBECONFIG" | base64 -d > "$KUBECONFIG"
  - chmod 600 "$KUBECONFIG"

.knext_kubeconfig_cleanup: &knext_kubeconfig_cleanup
  - rm -f "/tmp/knext-kubeconfig-\${CI_JOB_ID:-$$}"

.knext_kubectl_install: &knext_kubectl_install
  - |
    if ! command -v kubectl >/dev/null 2>&1; then
      curl -fsSLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
      echo "${KUBECTL_SHA256_LINUX_AMD64}  kubectl" | sha256sum -c -
      chmod +x kubectl
      mv kubectl /usr/local/bin/kubectl
    fi

# ── Kubeconfig check — ALWAYS runs, never conditional on the hazard check ──
# ADR-0061: an exec/auth-provider kubeconfig runs a cloud CLI on this runner
# with a cloud account's credentials in scope. Its own job — not a step inside
# credential-preflight — so nothing can special-case it away the way an
# \`allow_failure\`/\`when: manual\` on a shared job could.
kubeconfig-check:
  stage: preflight
  image: node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
  script:
    - *knext_kubeconfig
    - $KNEXT_CLI doctor --ci-kubeconfig "$KUBECONFIG"
  after_script:
    - *knext_kubeconfig_cleanup

# ── Credential preflight — refuse more than we asked for ────────────────────
# ADR-0049/#1495: a cluster-admin kubeconfig, or one with any grant outside
# the published Role, must be refused, not merely discouraged. Depends on
# kubeconfig-check so the exec-plugin refusal always runs BEFORE this job's
# first kubectl call.
credential-preflight:
  stage: preflight
  image: node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
  needs:
    - kubeconfig-check
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
  script:
    - |
      if command -v apk >/dev/null 2>&1; then
        apk add --no-cache curl bash
      fi
    - *knext_kubeconfig
    - *knext_kubectl_install
    - $KNEXT_CLI ci-preflight --namespace "$KNEXT_NAMESPACE" --kubeconfig "$KUBECONFIG"
  after_script:
    - *knext_kubeconfig_cleanup

# ── Deploy — build, push, apply ──────────────────────────────────────────────
# \`kn-next deploy\` runs \`docker buildx build … --push\` (deploy.ts), so this
# job needs an actual docker daemon AND the buildx plugin — a plain
# \`image: node:22\` has neither, and Alpine's \`docker-cli\` package alone ships
# only \`/usr/bin/docker\`, not buildx (a separate package, \`docker-cli-buildx\`).
# This pairs a docker-in-docker service with a docker-CLI-and-buildx-capable
# job image, GitLab's own recipe for exactly this:
# https://docs.gitlab.com/ci/docker/using_docker_build/#use-docker-in-docker
# \`resource_group\` serialises deploys per namespace — two concurrent pipelines
# on \`main\` must not race two applies of the same NextApp.
deploy:
  stage: deploy
  image: node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
  services:
    - docker:27.3.1-dind@${DIND_DIGEST}
  variables:
    DOCKER_HOST: tcp://docker:2376
    DOCKER_TLS_CERTDIR: "/certs"
    DOCKER_TLS_VERIFY: "1"
    DOCKER_CERT_PATH: "$DOCKER_TLS_CERTDIR/client"
  needs:
    - kubeconfig-check
    - credential-preflight
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
  resource_group: knext-deploy-$KNEXT_NAMESPACE
  script:
    - |
      if command -v apk >/dev/null 2>&1; then
        apk add --no-cache docker-cli docker-cli-buildx curl bash
      fi
    - *knext_kubeconfig
    - *knext_kubectl_install
    - printf '%s' "$KNEXT_REGISTRY_TOKEN" | docker login "\${KNEXT_REGISTRY%%/*}" -u "\${KNEXT_REGISTRY_USERNAME:-gitlab-ci-token}" --password-stdin
    - cd ${appDir}
    - npm ci
    - $KNEXT_CLI deploy --namespace "$KNEXT_NAMESPACE" --registry "$KNEXT_REGISTRY"
  after_script:
    - *knext_kubeconfig_cleanup
`;
}
