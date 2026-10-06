---
"@getknext/core": patch
---

The CRD-schema preflight now names only the unknown fields present in the NextApp CR being applied, not every field this CLI version can emit. A `--private` deploy against an older operator no longer also blames `spec.security.writeFree` when the CR carries no such field.
