# Quickstart — deploy your first scale-to-zero Next.js app

This guide takes you from an empty cluster to a deployed Next.js app that scales
to zero when idle and cold-starts on the next request. It uses only published
artifacts: the `kn-next-operator` install bundle and the `@knext/core` CLI.

**The flow:** install the operator once per cluster → install the CLI → add a
small config to your Next.js app → `kn-next deploy` builds and pushes your image
and submits a `NextApp` resource → the operator reconciles it into a Knative
Service with `minScale: 0`.

## Prerequisites

- A Kubernetes cluster with **Knative Serving + the Kourier networking layer**
  installed — follow the
  [official Knative install docs](https://knative.dev/docs/install/yaml-install/serving/install-serving-with-yaml/)
  (install both the Serving components and Kourier). The operator bundle pins
  Kourier as the ingress class.
- **[cert-manager](https://cert-manager.io/docs/installation/)** installed in the
  cluster (the operator bundle includes certificates for its admission webhook).
- **kubectl** configured against that cluster.
- **Node.js 22.18 or newer** (24 LTS recommended). The CLI runs on plain Node —
  no Bun required — and loads your TypeScript config file with Node's built-in
  TypeScript support, which needs ≥ 22.18.
- **Docker with buildx** (or a compatible builder) and a **container registry
  you can push to** (for example `ghcr.io/<your-user>`), with `docker login`
  already done.
- A **cloud storage bucket for static assets** — GCS, S3, or MinIO — that is
  publicly readable, plus its provider CLI authenticated locally (`gsutil` for
  GCS, `aws` for S3, `mc` for MinIO). The deploy step uploads `_next/static`
  assets there so pods stay stateless. Everything uploaded — including your
  app's entire `public/` dir — is world-readable (standard Next.js semantics),
  so never put secrets in `public/`.

## Step 0 — Preflight the cluster with `kn-next doctor`

Before (and after) installing anything, let the CLI check the cluster for you.
Once the CLI is available (Step 2 — or just `npx --package @knext/core kn-next
doctor` without installing), run:

```sh
npx @knext/core doctor
```

It verifies, read-only, everything the deploy path depends on: Knative Serving
is installed, the configured ingress-class actually has a reconciler serving it
(a mismatched class makes routes silently never program), cert-manager is
present, the NextApp CRD and operator are installed and Ready, and the operator
image is anonymously pullable by fresh nodes. Each check reports
`PASS`/`WARN`/`FAIL` (or a clear `SKIP` when the cluster is unreachable), and
the command exits non-zero only on hard failures. `--json` emits the results
machine-readably.

On a brand-new cluster the CRD/operator checks will FAIL until Step 1 — run
doctor again after the install and everything should be green.

## Step 1 — Install the operator

Every `main` build of the operator publishes a digest-pinned install bundle
(CRDs + RBAC + the manager Deployment + the Knative ConfigMaps it needs) as a
GitHub release asset. Install it with one apply:

```sh
kubectl apply --server-side -f https://github.com/getknext-dev/knext/releases/latest/download/install.yaml
```

Use `--server-side` so the bundle's `config-network` and `config-features`
ConfigMaps merge into the ones Knative Serving already owns instead of
replacing them.

Check the operator is running:

```sh
kubectl get pods -n kn-next-operator-system
```

### Optional: verify the image signature

The operator image is signed with cosign (keyless, Sigstore). To verify before
trusting it, read the pinned digest out of the bundle and check the signature:

```sh
curl -sL -o install.yaml https://github.com/getknext-dev/knext/releases/latest/download/install.yaml
grep 'image: ghcr.io/getknext-dev/kn-next-operator' install.yaml
```

Then, with the `@sha256:...` digest from that line:

```sh
cosign verify ghcr.io/getknext-dev/kn-next-operator@sha256:<digest> \
  --certificate-identity-regexp 'https://github.com/getknext-dev/knext/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Step 2 — Install the CLI

Add `@knext/core` to your Next.js app as a dev dependency (this also gives you
the config types):

```sh
npm install --save-dev @knext/core
```

This installs the `kn-next` command, runnable with `npx @knext/core`. You can also
install it globally (`npm install -g @knext/core`) if you prefer a bare
`kn-next` on your PATH. Sanity check:

```sh
npx @knext/core --help
```

## Step 3 — Prepare your Next.js app

`kn-next deploy` expects a monorepo-style layout: your app lives **two directory
levels below the repository root** (for example `my-repo/apps/hello-knext`), and
the Docker build runs with the **repository root as the build context** and the
**`Dockerfile` in your app directory**. If your app currently sits at the top of
its own repo, move it under `apps/<name>/` first:

```text
my-repo/
└── apps/
    └── hello-knext/        # run kn-next from here
        ├── Dockerfile
        ├── kn-next.config.ts
        ├── next.config.ts
        ├── package.json
        └── src/ or app/ ...
```

Your app needs three things:

**1. A `build` script** in `package.json` — the CLI runs `npm run build`:

```json
{
  "scripts": {
    "build": "next build"
  }
}
```

**2. Standalone output** in `next.config.ts`, plus the two environment variables
the CLI sets at build time:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required: self-contained server.js output for the container image.
  output: "standalone",
  // kn-next sets ASSET_PREFIX so browsers load static assets from your bucket.
  // Unset in `next dev`, so local development is unaffected.
  assetPrefix: process.env.ASSET_PREFIX || "",
  // kn-next sets NEXT_DEPLOYMENT_ID (the deploy tag). Pinning the build ID to it
  // keeps the uploaded asset paths and the deployed build in lock-step, and
  // deploymentId pins each browser session to the build it loaded.
  generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null,
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || undefined,
};

export default nextConfig;
```

**3. A `Dockerfile`** in the app directory. A minimal one for the layout above
(remember: `COPY` paths are relative to the **repository root**):

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /repo
COPY . .
WORKDIR /repo/apps/hello-knext
RUN npm ci && npm run build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
# Knative injects PORT; the standalone server binds HOSTNAME:PORT.
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=builder /repo/apps/hello-knext/.next/standalone ./
COPY --from=builder /repo/apps/hello-knext/.next/static ./.next/static
COPY --from=builder /repo/apps/hello-knext/public ./public
EXPOSE 8080
CMD ["node", "server.js"]
```

> If your repository root contains a lockfile or workspace config, Next.js nests
> the standalone output under your app's path (e.g.
> `.next/standalone/apps/hello-knext/server.js`) — adjust the `COPY` paths and
> `CMD` accordingly.

## Step 4 — Author `kn-next.config.ts`

Create `kn-next.config.ts` next to your `package.json`. This is the smallest
config that works — `name`, `registry`, and `storage` are required:

```ts
import type { KnativeNextConfig } from "@knext/core";

const config: KnativeNextConfig = {
  // App name — becomes the NextApp resource and Knative Service name.
  name: "hello-knext",
  // Registry to push the image to (the app name is appended).
  registry: "ghcr.io/<your-user>",
  // Bucket for static assets; publicUrl is where browsers fetch them from.
  storage: {
    provider: "gcs", // "gcs" | "s3" | "minio"
    bucket: "<your-assets-bucket>",
    publicUrl: "https://storage.googleapis.com/<your-assets-bucket>",
  },
};

export default config;
```

Scale-to-zero is the default — you do not need a `scaling` block. If you add
one, `minScale: 0` (the default) is what keeps scale-to-zero on.

## Step 5 — Build and deploy

Preview first. `--dry-run` skips the asset upload, the image build/push, and
the cluster apply, and prints the `NextApp` resource the CLI would submit. It
still runs `next build` — add `--skip-build` to skip that too:

```sh
npx @knext/core deploy --dry-run --skip-build
```

Then deploy for real:

```sh
npx @knext/core deploy
```

One command does all of it, in order:

1. Runs `next build` (standalone output) with the asset prefix and deployment ID
   set.
2. Uploads `_next/static` assets and public files to your bucket (in parallel
   with the image build).
3. Builds the container image with `docker buildx` for `linux/amd64` and pushes
   it to your registry.
4. Resolves the pushed image's `@sha256:` digest — the operator only accepts
   digest-pinned images, never `:latest`.
5. Writes a `NextApp` resource to `.output/nextapp-cr.yaml` and applies it with
   `kubectl`. The operator reconciles everything else (the Knative Service,
   networking, and a default-on internal-only NetworkPolicy).

Useful flags: `--tag <t>` to name the image tag (default: a timestamp),
`--namespace <ns>` (default: `default`), `--skip-build` and `--skip-upload` to
re-submit without rebuilding or re-uploading, `--registry` / `--bucket` to
override the config.

## Step 6 — Check your app with `kn-next status`

The operator writes its honest verdict onto the `NextApp` resource — URL,
`Ready` (with the reason and guidance when something is wrong, e.g. an ingress
that never programs), `Degraded`, and the database binding. `kn-next status`
renders it without a `kubectl describe`:

```sh
npx @knext/core status
```

Pass the app name explicitly (`npx @knext/core status hello-knext -n default`) when
you're outside the app directory. Useful flags:

- `--watch` — poll every 5 s until the app is Ready (bounded at 10 minutes).
- `--json` — emit the structured status for scripts.
- The exit code is non-zero iff `Ready=False`, so `kn-next deploy &&
  kn-next status --watch` works as a CI gate.

If the command reports the cluster as unreachable or the app as missing, run
`kn-next doctor` — it checks the prerequisites the deploy depends on.

## Step 7 — Watch it scale to zero (and back)

Get the app's URL from the status output above (it comes from the resource's
`status.url`). Open it in a browser or
curl it — the first request cold-starts a pod:

```sh
curl -i "$(kubectl get nextapp hello-knext -o jsonpath='{.status.url}')"
```

Now watch the pods drain to zero. After roughly 60–90 seconds with no traffic,
Knative terminates the pod:

```sh
kubectl get pods -w
```

You'll see the app pod go `Terminating` and disappear — you are now paying for
nothing. Hit the URL again while the watch is running and a fresh pod appears
and serves the request:

```sh
curl -i "$(kubectl get nextapp hello-knext -o jsonpath='{.status.url}')"
```

That round trip — zero pods → request → running pod → response — is the whole
point.

## Troubleshooting

**Pods stuck in `ImagePullBackOff` on the first deploy.** GitHub Container
Registry images are **private by default**, and the cluster cannot pull a
private image without credentials. Check what the operator and the revision
report:

```sh
kubectl describe nextapp hello-knext
kubectl get revisions -o wide
```

Fix either by making the package public (GitHub → your package →
Package settings → Change visibility) or by adding pull credentials to the
**app's ServiceAccount** — the operator runs your pods under `<name>-sa`
(so `hello-knext-sa` here), not the namespace's `default` ServiceAccount:

```sh
kubectl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<your-user> \
  --docker-password=<a-token-with-read:packages>
kubectl patch serviceaccount hello-knext-sa \
  -p '{"imagePullSecrets": [{"name": "ghcr-pull"}]}'
```

Then re-run `npx @knext/core deploy --skip-build --skip-upload` to roll a fresh
revision.

## Cleaning up

```sh
kubectl delete nextapp hello-knext
```

The operator tears down the Knative Service and everything it provisioned.

## Where next

- Full configuration schema (cache, scaling, observability, secrets): see the
  [Configuration Reference](../README.md#configuration-reference).
- Fronting your deployment with your own CDN that honors `s-maxage`? See
  [Cache-Control Normalization](../README.md#cache-control-normalization-knext_cache_control_normalize).
- The `NextApp` resource in depth: [docs/operator/crd-nextapp.md](./operator/crd-nextapp.md).
- Operator internals and install details:
  [packages/kn-next-operator/README.md](../packages/kn-next-operator/README.md).
