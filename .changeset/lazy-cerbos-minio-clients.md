---
"@getknext/lib": patch
---

`@getknext/lib/clients`: `getCerbosClient()` and `getMinioClient()` now load their SDKs
(`@cerbos/grpc` → `@grpc/grpc-js`, and `minio`) lazily, on first use, instead of at import time.
Together these two were about 60% of the ~0.8–0.9 s boot cost `@getknext/lib/clients` added when
an app imported it — paid even by apps that never called either getter. An app with tracing on, or
one that imports `@getknext/lib/clients` directly, no longer pays to load either SDK unless it
actually calls the corresponding getter.

Both getters keep their existing synchronous signatures — no public API change. Each now returns a
lightweight facade that loads the real SDK (once, memoized) the first time a method is actually
called on it; every existing call site is unaffected.
