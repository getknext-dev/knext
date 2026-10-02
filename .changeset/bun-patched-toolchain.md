---
"@getknext/core": minor
---

Add an opt-in, experimental patched Bun toolchain for the compile step:
`compile: { bun: "knext-patched", include: ["./plugins/*.js"] }` in
`knext.config.ts`. `knext build` downloads a knext-published Bun 1.4.2 build
that adds `--compile --include` (embed extra files as modules the executable
loads lazily), verifies it against a sha256 pinned in this package, and fails
the build on any mismatch rather than falling back to stock Bun. It is used for
the compile step only; the default (no `compile` block) is unchanged.
