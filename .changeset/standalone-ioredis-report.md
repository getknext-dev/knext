---
"@getknext/core": patch
---

The standalone self-contained compile now names a runtime `ioredis` load that a webpack build reaches through `createRequire`, the same way the vinext compile already reports it, so the build report says the package is loaded at runtime rather than leaving it unnamed.
