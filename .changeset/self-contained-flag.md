---
"@getknext/core": minor
---

Add an opt-in `selfContained` config key and a `knext build --self-contained`
flag (default off). No build target acts on it yet, so build output is
unchanged either way; the setting is validated as a boolean and recorded in the
build log.
