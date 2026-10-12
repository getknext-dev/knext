---
"@getknext/core": patch
---

The static-export refusal (`output: 'export'`) now covers the vinext build target, which previously built an export with nothing to deploy: `knext build`, `knext deploy` and `knext preview` refuse it before the build starts, with the same guidance as the Next.js path. The Next.js-path refusal also reads a custom `distDir` from `next.config` instead of assuming `.next`. On vinext only an unconditional top-level `output: 'export'` is refused; one under a condition or nested value prints a warning and the build continues. Both checks read `next.config` literally, so an `output` or `distDir` computed at runtime is not detected, and a `next.config` that exists but cannot be read is refused rather than assumed clean. Other build steps still assume the default `.next` directory.
