---
"@getknext/core": patch
---

`knext deploy --image <ref>@sha256:...` no longer fails on the scaffold's placeholder `registry` value. Nothing is built or pushed with a pre-built image, so the registry is not needed; every other placeholder (storage bucket, domains) still fails fast.
