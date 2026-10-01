---
"@getknext/core": patch
---

The compiled standalone-on-Bun build's disk-closure scan now logs a warning (once per distinct specifier) when a module a route chunk requires cannot be resolved under either the `require` or ESM/`default` export condition, instead of silently dropping it. The warning names the specifier, the directory it was required from, and both resolution attempts' errors.
