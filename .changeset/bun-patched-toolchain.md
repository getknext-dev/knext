---
"@getknext/core": minor
---

Add an opt-in, experimental patched Bun toolchain for the compiled vinext
executable: `compile: { bun: "knext-patched" }` in `knext.config.ts`.
`knext build` downloads a knext-published Bun 1.4.2 build that adds
`--compile --include` (Linux glibc x64 and arm64 build hosts), verifies it
against a sha256 pinned in this package, and fails the build on any mismatch
rather than falling back to stock Bun. `compile.include` keeps its meaning and
every safety check; with the patched toolchain the same checked files are
embedded through Bun's native `--include`, at the same paths. `compile.include`
now also refuses native addons (`.node`) with a clear message, in both modes.
The default (no `compile.bun`) is unchanged.
