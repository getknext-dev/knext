---
"@getknext/core": minor
---

The config file is now `knext.config.ts` (was `kn-next.config.ts`). **No
dual-read** — the CLI reads `knext.config.ts` only.

If your app still has `kn-next.config.ts`, rename it before your next `knext`
command:

```
mv kn-next.config.ts knext.config.ts
```

Running any `knext` command in a directory that still has the old filename
(and no `knext.config.ts`) now fails fast with one actionable error naming
the exact rename to make — never a silent fallback read and never a warning
that lets an old-named config keep working.

`knext create` scaffolds `knext.config.ts` for new apps. CLI messages, `doctor`
checks, the GitHub Action, and the docs site all say `knext.config.ts`
throughout.
