---
"@getknext/core": patch
---

`knext create` now scaffolds a `.gitignore` (both the default and `--builder vinext` variants). Previously scaffolded apps shipped none at all, so `node_modules`, `.next`, `.output`, compiled `knext-exec*`/`knext-standalone-exec*` binaries, and `.env` files were all committable by default — the `.env` case is a secret-leak risk. The template ships internally as `gitignore.hbs` (npm strips a file literally named `.gitignore` from a published tarball) and is renamed to `.gitignore` when an app is scaffolded.
