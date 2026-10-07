---
"@getknext/core": patch
---

`knext doctor` now warns, instead of failing, when the installed CRD lacks only fields the CLI emits for a specific feature (`spec.security.writeFree` for CLI-built images, `spec.networking` for private apps), and names the feature. A missing always-emitted field still fails.
