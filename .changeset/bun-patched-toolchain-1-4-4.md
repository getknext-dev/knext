---
"@getknext/core": patch
---

The opt-in patched Bun toolchain (`compile: { bun: 'knext-patched' }`) is now built from Bun 1.4.4 instead of 1.4.2, still with `--compile --include` added. `knext build` downloads the new `bun-patched-1.4.4-knext.3` release and checks it against its pinned sha256, exactly as before. The default, the Bun on your `PATH`, is unchanged.
