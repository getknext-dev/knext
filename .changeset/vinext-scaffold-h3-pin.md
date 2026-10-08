---
"@getknext/core": patch
---

New vinext apps now pin `h3` to `2.0.2` (npm, Bun, pnpm and Yarn overrides). The `h3` that Nitro pins answered a malformed path such as `/%2/` with a 500 or an uncaught error; the pinned release answers 400.
