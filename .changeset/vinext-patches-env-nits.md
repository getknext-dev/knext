---
"@getknext/core": patch
---

`KNEXT_VINEXT_PATCHES` values that are not recognised (a misspelling such as `stric`) now print a warning that names the value and lists the accepted ones (`0`, `strict`, or unset), instead of falling back to the default warn mode silently. The default behaviour is otherwise unchanged. `knext doctor` no longer suggests setting `KNEXT_VINEXT_PATCHES=strict` when strict is already the active mode.
