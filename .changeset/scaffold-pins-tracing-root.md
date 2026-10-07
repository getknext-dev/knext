---
"@getknext/core": patch
---

A scaffolded app now builds on the first try when a lockfile sits in a parent directory, as it does after the documented `npm i @getknext/core` followed by `knext create`. The scaffolded `next.config.ts` pins the file-tracing root to the app (`outputFileTracingRoot`, plus `turbopack.root` on the default builder), so Next.js no longer moves the workspace root up and nests the standalone server. `knext build` also recognises that nested layout when it still happens, for example in an existing app, and fails with the real cause: it names the inferred root and the lockfile behind it, and says to set `outputFileTracingRoot` or remove the lockfile. Before, it blamed `output: 'standalone'`, which was set correctly. The docs now say so.
