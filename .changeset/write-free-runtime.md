---
"@getknext/core": minor
---

Cold start: apps with object storage, and vinext apps, no longer need a writable volume.

Each writable `emptyDir` the operator mounts costs pod-sandbox setup time on every scale-from-zero wake. Two app shapes still got one by default; they no longer need it:

- **Standalone apps with `storage` configured.** The knext adapter now sets Next's official `images.customCacheHandler` option when the app uses the knext cache handler, so optimized `next/image` variants are stored through the cache handler instead of `.next/cache/images` on local disk: on the Bun runtime with Redis configured, in Redis (shared across pods and kept across scale-to-zero). Otherwise they go in a per-pod in-memory cache capped at 32 MiB (`KNEXT_IMAGE_CACHE_MEMORY_BYTES`). That includes the Node runtime for now: its standalone image cannot reach Redis yet, so it falls back to the memory cache and re-optimizes variants after each scale-to-zero. Set `KNEXT_IMAGE_CACHE_HANDLER=0` at build time to keep Next's disk cache. The object-storage image sync now stands down when images are stored through the cache handler, or when its directory is not writable, instead of erroring on every wake.
- **vinext apps built as a disk-mode binary** (the default). sharp loads from the image's read-only `native/` directory, so nothing is written at runtime.

`knext deploy` now sets a new optional `NextApp` field, `spec.security.writeFree: true`, for an image it built in the same run when that image writes nothing to local disk. The operator then renders no writable volume at all, with `readOnlyRootFilesystem` still on. The CLI sets it only when it changes the result, so a standalone app without storage gets the same `NextApp` as before. It is never set for `--image` / `--skip-build` deploys or for self-contained vinext binaries, which still unpack sharp into `/tmp`. `spec.security.writableCache: true` still mounts both writable paths.

**Upgrade order:** upgrade the operator (and its CRD) before the CLI. A CLI that sets `spec.security.writeFree` against an older CRD fails the deploy preflight with `unknown field "spec.security.writeFree"`.
