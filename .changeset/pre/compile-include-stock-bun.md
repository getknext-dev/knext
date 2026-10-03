---
"@getknext/core": minor
---

Add `compile.include` (experimental) for the compiled vinext executable:
`compile: { include: ["plugins/*.js"] }` in `knext.config.ts` embeds the
matching JavaScript/TypeScript modules in the executable, where they load on
their first import from `/$bunfs/root/<path relative to the app root>` — not
at startup, and with nothing beside the binary. Works on stock Bun. A pattern
that matches nothing, a non-module match, or use on another build target fails
the build or the config check.
