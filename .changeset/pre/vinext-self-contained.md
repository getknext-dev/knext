---
"@getknext/core": minor
---

`knext build --self-contained` (or `selfContained: true`) now takes effect on the
vinext target: the single executable embeds the server runtime, `.output/public`
and sharp's native libraries, so it serves from a directory that holds nothing
but the binary. The native libraries are unpacked into the temp directory the
first time an image is optimized — boot and health checks never pay for it —
so that directory must be writable (the knext operator mounts one at `/tmp`).
Off by default; disk-mode builds are unchanged.
