---
"@getknext/core": patch
---

`knext deploy --image <ref>` no longer refuses because of a stale compiled executable left in the checkout by an older build. A pre-built image ships nothing from the local tree, so the local freshness check now runs only for `--skip-build` without `--image`, where the image is still built from the checkout.
