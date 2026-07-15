# Deploying knext-docs (dogfood runbook)

This documentation site is dogfooded **on knext** (issue #55, P2-1). It is a Next.js App-Router app
that builds with `output: 'standalone'` + the knext official adapter, then deploys as a
scale-to-zero Knative Service via a `NextApp` CR.

> **Honest scope.** This is a **runbook**, not an automated, gated pipeline. A real deploy requires a
> live Kubernetes cluster with Knative Serving, a container registry, and an object-storage bucket
> with credentials. None of that is provisioned by CI here — CI only verifies the build and the
> config (see `.github/workflows/ci.yml`). Treat the steps below as the manual procedure.

## Prerequisites

- A Kubernetes cluster with **Knative Serving** installed.
- The **knext operator** (`packages/kn-next-operator`) installed in the cluster (it reconciles the
  `NextApp` CR).
- A container **registry** you can push to.
- An object-storage **bucket** (`gcs`, `s3`, or `minio`) + credentials for asset upload.
- A checkout of the knext repo (the `kn-next` CLI is not on npm yet — issue #53).

## 1. Resolve `@knext/core`

`package.json` depends on `@knext/core` via a `file:../knext/packages/kn-next` path for local builds.
For a container build, either:

- vendor the package into the build context, or
- switch to the published `@knext/core` once issue #53 (npm publish) lands.

## 2. Validate the deploy config

```bash
npm run config:validate   # runs the real kn-next validateConfig() against kn-next.config.ts
```

`kn-next.config.ts` is minimal-valid: `name`, `registry`, `storage{provider:gcs, bucket, publicUrl}`,
`scaling.minScale: 0`. No cache block (the docs site is static — no Redis, no ISR).

## 3. Build + push the image

```bash
docker build -t registry.example.com/knext-docs:$(git rev-parse --short HEAD) .
docker push registry.example.com/knext-docs:$(git rev-parse --short HEAD)
# capture the resulting @sha256: digest — the operator REJECTS non-digest-pinned images.
```

## 4. Deploy via the kn-next CLI (operator path)

From a knext checkout, with this repo's `kn-next.config.ts` on the path:

```bash
kn-next deploy --registry registry.example.com/knext-docs
# emits a NextApp CR (apps.kn-next.dev/v1alpha1) and applies it;
# the operator reconciles it into a scale-to-zero Knative Service.
```

`--dry-run` prints the `NextApp` CR without applying it — useful to inspect first.

## 5. Verify

```bash
kubectl get nextapp knext-docs -o wide      # status.url, conditions
kubectl get ksvc                            # Knative Service, should scale to 0 when idle
```

## Rollback

```bash
kn-next rollback knext-docs --to <previous-revision>   # optionally --canary <n>
```
