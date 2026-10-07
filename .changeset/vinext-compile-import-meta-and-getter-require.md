---
"@getknext/core": patch
---

Fixes two cases where `kn-next build --target=vinext` (the Bun single-executable
compile step) could fail or crash a compiled app that would otherwise work fine:

- A dependency whose own source text happens to mention "import.meta" inside a
  string (for example a diagnostic message that names the language feature by
  name) could abort the compile with an "import.meta use(s) survived the
  rewrite" error, even though the dependency has no real unhandled
  `import.meta` syntax. The compile step now recognizes real `import.meta`
  usage correctly instead of matching on raw text.
- A page or route whose server code reaches a package only through a runtime
  `require()` call that Bun's bundler cannot see statically could compile
  successfully but then crash every request with `Cannot find module '<pkg>'`.
  The compile step now recognizes this call shape and bundles the package the
  same way it already does for other runtime requires, so the compiled binary
  no longer crashes on it.
- In a monorepo, a dependency hoisted to the workspace root and reached from
  the app only through a symlink (common with npm/pnpm/bun workspaces) could
  be wrongly treated as unresolvable and left out of the compiled binary,
  even though it is a real, declared dependency. The compile step now
  recognizes any workspace-hoisted dependency as in-scope, while still
  refusing to silently bundle an unrelated package that merely happens to sit
  higher up on the build machine's own disk.
- Code that merely CHECKS whether an optional package is installed (the
  common `try { require.resolve('pkg') } catch { ... }` pattern, used for an
  optional dependency that is not expected to be present in production)
  could now fail the whole build with `--self-contained` or
  `KNEXT_COMPILE_STRICT_REQUIRES=1`, even though the check already handles
  the package being absent at runtime. The compile step now recognizes this
  as a plain existence check, not a load, and leaves it alone.

No config, CLI flag, or public API changed.
