---
"@getknext/core": patch
---

Two cold-start fixes (measured on GKE, ~1s combined saving per wake):

- The operator no longer mounts an `emptyDir` volume by default under `readOnlyRootFilesystem: true` — provisioning that volume cost pod-sandbox setup time on every scale-from-zero wake whether or not anything was ever written to it. `readOnlyRootFilesystem` stays on by default. A new, additive opt-in field, `spec.security.writableCache`, restores the previous mounts (`/tmp`, and for the standalone build shape, Next's image-optimizer/ISR-fallback cache) for an app that needs guaranteed local writes.
- The operator's default CPU **limit** is raised from `1000m` to `4000m` (the **request** is unchanged at `250m`), reducing CFS throttling during the CPU-bound boot window. `kn-next deploy`'s own default follows the same change. Both remain fully overridable per app.
