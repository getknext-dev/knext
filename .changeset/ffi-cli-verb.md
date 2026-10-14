---
"@getknext/core": minor
---

Add `knext ffi` (Beta, Bun only): `knext ffi init`, `knext ffi generate` and `knext ffi check` let a zone call Rust functions in-process through Bun's `bun:ffi`, with a typed, server-only TypeScript wrapper generated from the Rust library. The commands come from the optional `@getknext/ffi` package, which is not published yet; until it is installed, `knext ffi --help` lists the commands and how to install it, and any other `knext ffi` command explains and exits 1. A `@getknext/ffi` whose supported `@getknext/core` range does not include your core version is refused, with both versions named. In-process Rust runs only on the Bun runtime and stays Beta while Bun marks `bun:ffi` experimental.
