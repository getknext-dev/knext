---
"@getknext/core": patch
---

In-process Rust (Beta): a Rust call that blocks for longer than a threshold is now visible. The module `knext ffi generate` writes times every call; a call slower than `KNEXT_FFI_SLOW_CALL_MS` (default 50 ms; `0` turns it off) is counted in `knext_ffi_slow_calls_total`, labelled `fn`, and the first one per function logs a line with the time it took. `knext_ffi_load_seconds`, labelled `lib`, reports how long the first call spent loading and checking the library. On the standalone build both reach the app's Prometheus endpoint on port `9464` through the same local metrics listener as the `'use cache'` counters. Counting does not make a slow call interruptible: it still blocks every other request on the pod, and a graceful shutdown cannot drain until it returns. Regenerate the module with `knext ffi generate` to pick this up; a Rust function or argument can no longer be named `Map`, `Symbol`, `globalThis` or `performance`.
