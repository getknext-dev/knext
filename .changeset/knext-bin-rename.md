---
"@getknext/core": minor
---

The CLI command is now `knext` (was `kn-next`). `@getknext/core` ships both
bins — `knext` is canonical, and `kn-next` keeps working as a deprecated
alias: same dispatch, same flags, same exit codes, with one added line on
stderr pointing at `knext`. Existing scripts and CI invoking `kn-next` are
not broken by this release.

`knext create` now scaffolds apps whose generated `package.json`, README-style
comments, and printed "next steps" all say `knext`. The config file itself is
unchanged — it is still named `kn-next.config.ts` (not renamed in this
release).

CLI help/usage text, error messages, and the docs site (getting-started, CLI
reference, examples) were updated to say `knext` throughout, with a short note
in the getting-started guide about the `kn-next` alias.
