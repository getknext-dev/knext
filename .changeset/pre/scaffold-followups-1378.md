---
"@getknext/core": patch
---

Three scaffold/CLI follow-ups from the #1368 review:

- The turbopack pre-build guard (`checkTurbopackAdapterStandaloneRegression`)
  no longer falsely blocks an app whose `build` script delegates to other
  scripts (e.g. `"build": "run-s build:*"` with `--webpack` on a
  `"build:next"` script) — it now scans every script in `package.json`, not
  just `build`, for the escape-hatch flag, and the error message documents
  the delegation case.
- The scaffolded `next.config.ts` (both the default and `--builder vinext`
  variants) no longer carries internal issue/PR/ADR references in its
  comments.
- `kn-next build` on the default (standalone) target writes a compiled
  `knext-standalone-exec-<arch>` ship binary into the app root. It was not
  covered by any `knext-exec*` ignore pattern (a different, older binary
  name) — this repo's own root `.gitignore` and the scaffold's
  `.dockerignore.hbs` / `Dockerfile.vinext-node.dockerignore.hbs` now exclude
  it too.
