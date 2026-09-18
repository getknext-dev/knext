# #306 — EKS end-to-end validation (operator/CLI deploy path)

Closing the last v1.0-blocker: validate the **full `kn-next deploy` → NextApp CR → operator → ksvc**
path on a second real cloud (EKS), not just the runtime (the earlier bench used raw ksvcs). Live run
on EKS `knext`, `eu-west-1`, acct 319793009555. **In progress.**

## Done ✅
- **EKS cluster** (eksctl `docs/release/eks-cluster.yaml`, 2× t3/c6i spot). kubeconfig wired.
- **gp3 default StorageClass** created (EKS ships none — Knative/PVCs need a default).
- **Knative Serving + Kourier v1.18** installed; ingress-class=kourier, podspec-fieldref=enabled.
- **cert-manager v1.16** installed (operator webhook dependency — see delta 2).
- **knext operator DEPLOYED + Running** — `dist/install.yaml` operator image copied GHCR→ECR by
  digest (amd64), controller 2/2, `nextapps.apps.kn-next.dev` CRD installed, pulls from ECR in ~1.5s.
  This is the leg the bench skipped.

## EKS-specific deltas (for the portability doc / README)
1. **No default StorageClass.** Create a `gp3` `ebs.csi.aws.com` default; k8s ≥1.28 binds existing
   Pending PVCs retroactively.
2. **Operator requires cert-manager.** `dist/install.yaml` ships a `Certificate` + `Issuer`
   (`cert-manager.io/v1`) for the webhook; a fresh cluster must install cert-manager FIRST or the
   apply fails `no matches for kind "Certificate"`. **Recommend documenting this as an operator
   install prerequisite** (or bundling a cert-manager check in `kn-next doctor`).
3. **Operator image is PRIVATE on GHCR.** `ghcr.io/getknext-dev/kn-next-operator` returns
   `UNAUTHORIZED` anonymously — a user deploying knext on their own cluster cannot pull it without
   GHCR auth or a mirror. **Real portability gap:** either make the operator package public, or
   document the pull-secret/mirror step. (For this validation it was copied to ECR via a gh token.)
4. **Kourier LB is a hostname on EKS** (ELB), not an IP — resolve for `sslip.io` (from the bench).
5. **Docker Hub NAT rate-limits** node pulls — mirror public images to ECR (from the bench).

## CLI deploy path — validated + bugs found
- ✅ **`kn-next doctor` runs against EKS** (exercises the decomposed `doctor.ts`, #1055, on a real 2nd
  cloud). Read-only checks all pass except the skew below.
- ✅ **CLI generates a valid NextApp CR** (`deploy --dry-run`) with `--registry`/`--bucket` overrides —
  image, scaling, storage, cache(redis), secrets, `build: vinext`.
- ✅ **Operator admission webhook enforces digest-pinning** — a tag-only image ref is rejected
  (`has a tag but no digest pin`), the security invariant working on EKS.
- 🐛 **CRD/controller version skew (the load-bearing #306 finding).** The only *published* operator is
  `v0.1.0` (GHCR), which is **behind main's CLI**: its CRD lacks `spec.build` + `spec.scaling.scaleDownDelay`
  that the CLI emits — `doctor`'s `preflightCRSchema` catches it (FAIL, "upgrade operator/CRD first").
  Applying main's CRD onto the v0.1.0 *controller* then fails to reconcile (controller lacks PVC-list RBAC
  from the newer bundle; NextApp gets no status, no ksvc). **Conclusion: the current deploy path cannot be
  validated against the stale published operator — a lockstep current operator must be built/published.**
  (Building it locally: `docker buildx` subcommand won't route on this host — must invoke the plugin
  binary `~/.docker/cli-plugins/docker-buildx` directly; Go cross-compiles amd64 via `GOARCH=amd64`.)
- 🐛 **`--skip-build` skips only `next build`, NOT the docker image build/push** — it still shells
  `docker buildx build … --push`. So there's no CLI path to deploy a *pre-built* image; a user without a
  working buildx cannot deploy. Worth a real `--image <ref>` / true skip-image flag.

## ✅ CORE DEPLOY PATH PROVEN END-TO-END ON EKS (dated run)
With a **current operator built from main** (`kn-next-operator:main@sha256:f4f483a2…`, cross-compiled
amd64, RBAC from main's kustomize bundle), the full path works:
1. `kn-next deploy` generates the **NextApp CR** (`--registry`→ECR override).
2. The **operator reconciles the CR → Knative Service** ("Successfully reconciled NextApp", ksvc created
   by the operator — ADR-0001 single-writer; a **raw** ksvc is never applied by the CLI).
3. ksvc → revision → pod pulls the app image from ECR (86 MB, ~17 s cold pull).
4. App boots the **full knext runtime** (Next.js 16.0.3 + Redis cache-handler + Postgres health check),
   **"✓ Ready in 789 ms"** once a real data plane is present.
5. **Kourier routes** the external `*.sslip.io` domain to the pod → **`/api/health` 200** `{"status":"ok"}`,
   **`/` 200** (HTML).
6. Bumping the CR's `buildId` → operator rolls a **new revision** (00002) → fresh pod. Traffic shifts.

**Conclusion: the operator/CLI deploy path works on a second real cloud (EKS).** The load-bearing #306
risk is retired.

## Bugs to file (found by this validation)
- **B1 — operator RBAC missing `persistentvolumeclaims` list.** The controller-runtime cache watches
  PVCs but `config/rbac` grants no PVC list at cluster scope → repeated `cannot list … forbidden` errors.
  Non-fatal today (reconcile still succeeds) but noisy and would break any PVC-dependent path. Add the
  RBAC marker + regenerate. **Real bug on main.**
- **B2 — operator image private on GHCR (#198).** Fresh nodes can't pull it anonymously; a user needs an
  imagePullSecret or the package must be public.
- **B3 — operator install requires cert-manager**, undocumented. Either document as a prerequisite or add
  a `kn-next doctor` check (doctor already reports cert-manager readiness — extend to a hard prereq note).
- **B4 — `--skip-build` skips only `next build`, not the docker image build/push.** No CLI path to deploy
  a pre-built image; add a real `--image <ref>` / true skip-image flag.
- **B5 — no *published* lockstep operator.** The only published operator (v0.1.0) is behind the CLI; the
  release cadence must publish a current operator or the CLI-vs-operator skew is unfixable by users.

## Remaining #306 AC legs (data plane + docs + CI)
- [ ] `kn-next deploy --registry <ECR>` on `apps/file-manager` (build → push → NextApp CR) → confirm
      the operator reconciles it into a running ksvc (ADR-0001: CR is the only cluster write). The CLI
      build shells `bun build --compile` for the vinext target (ADR-0048) + pushes to ECR — verify the
      build toolchain + ECR push work from the CLI on this setup.
- [ ] Validate **S3 asset upload** (real bucket via `STORAGE_BUCKET`), **Redis cache-handler**,
      **ISR/tag invalidation** on EKS.
- [ ] Cold-start + throughput numbers (have runtime numbers from `eks-bunexec-bench.md`).
- [ ] README/portability doc: list EKS **validated** with the dated run.
- [ ] CI smoke workflow (gated/manual to avoid cost).

## Teardown (when done — stops ~$0.30–0.50/hr spot)
`eksctl delete cluster --name knext --region eu-west-1` (auto-deletes the Kourier ELB). Then the
ECR repos (kn-next-operator, knext-file-manager, + any mirrors) via `aws ecr delete-repository --force`.
