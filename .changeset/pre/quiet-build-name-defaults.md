---
"@getknext/core": minor
---

A default `knext build` no longer prints a dozen multi-line compile notes. They are folded into one line, such as `[knext standalone-compile] 12 notes; rerun with --verbose for details`, and the new `knext build --verbose` (or `KNEXT_VERBOSE=1`) lists them all. The same applies to the `[knext compile]` lines of the vinext target. Warnings, errors and strict-mode failures still print in full, and a failed compile prints every held note first. `knext create` now names the build target and runtime it chose, defaults included, and how to change them with `--builder` and `--runtime` or the `build` and `runtime` keys in `knext.config.ts`.
