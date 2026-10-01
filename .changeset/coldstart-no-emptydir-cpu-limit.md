---
"@getknext/core": patch
---

Cold-start fix: the operator no longer mounts an `emptyDir` volume by default under `readOnlyRootFilesystem: true` for a standalone app with no object storage configured — provisioning that volume cost pod-sandbox setup time on every scale-from-zero wake whether or not anything was ever written to it. `readOnlyRootFilesystem` stays on by default.

Two writes stay mounted unconditionally, by default, because they are not optional for the shape that needs them: `/tmp` for any self-contained single-executable build (`build: vinext`, or `selfContained: true`), and Next's image-optimizer cache directory for a standalone app with `spec.storage` configured. A new, additive opt-in field, `spec.security.writableCache`, restores the pre-existing unconditional mounts for an app that wants guaranteed local writes outside those two cases.

(A companion change raising the default CPU limit was evaluated and reverted after review — it risked silent `FailedCreate` rejections on clusters with a `LimitRange`. The default CPU limit stays `1000m`; see `docs/operator/scaling-cold-start.md` for the opt-in recipe.)
