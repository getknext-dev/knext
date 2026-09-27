---
"@getknext/core": minor
---

Add an opt-in `selfContained` config key and a `knext build --self-contained`
flag (default off). No build target acts on it yet, so the artifacts a build
produces are byte-identical either way; the setting is validated as a boolean
and recorded in the build log (the "Configuration loaded" line now always
carries a `selfContained` field).
