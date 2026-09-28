---
"@getknext/core": patch
---

The scaffolded `vinext` server entries now warm `KNEXT_WARM_PATH` inside the
same execution context as live requests. Work a warm route schedules with
`after()` is therefore awaited by the image's compile-cache bake and by the
SIGTERM drain, instead of being cut off when the process exits.
