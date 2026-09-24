---
"@getknext/core": patch
---

Security: the standalone runtime image no longer includes the app's `.env*` files or other secret files (`*.pem`, `*.key`, `*.p12`, `.npmrc`, `.netrc`, kubeconfig) copied by `next build` into `.next/standalone/`. Previously the generated ignore rules only excluded these at the build-context root.

If you built images with the standalone target and kept secrets in `.env*` files, rebuild your images with this release and rotate those secrets. Supply secrets through `env` / `secrets` in `kn-next.config.ts` (Kubernetes Secrets) instead of `.env*` files.
