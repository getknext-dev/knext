---
"@getknext/core": patch
---

A glob (such as `'/img/**'`) or `//` inside a string in your `next.config` no longer hides `outputFileTracingRoot` or `turbopack.root` from knext. knext reads these settings to pick the Docker build context. Previously, comment-like text inside a string could make knext treat the setting as missing and fall back to the lockfile-inferred root.
