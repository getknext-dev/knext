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

No config, CLI flag, or public API changed.
