---
"@getknext/lib": patch
---

`@getknext/lib/clients`: `getCerbosClient()` and `getMinioClient()` now load their SDKs
(`@cerbos/grpc` → `@grpc/grpc-js`, and `minio`) lazily, on first use, instead of at import time.
Together these two were about 60% of the ~0.8–0.9 s boot cost `@getknext/lib/clients` added when
an app imported it — paid even by apps that never called either getter. An app with tracing on, or
one that imports `@getknext/lib/clients` directly, no longer pays to load either SDK unless it
actually calls the corresponding getter.

This changes both getters' return type from a synchronous client to `Promise<Client>` — callers
now `await` them. `@getknext/core`'s own callers (the adapter's build-time upload, the image-cache
sync) and the file-manager reference app's upload action are updated; any other caller of
`getMinioClient()`/`getCerbosClient()` needs the same one-line `await`.
