---
"@getknext/core": patch
---

`knext build` now stages the standalone docker build context (`Dockerfile.standalone` and the entry shims) for the Node and Bun targets, the same files `knext deploy` stages, and prints the context path and build command, so the image can be built on a remote builder.
