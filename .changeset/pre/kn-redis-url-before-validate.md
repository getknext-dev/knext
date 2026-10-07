---
"@getknext/core": patch
---

`knext deploy` now honours `KN_REDIS_URL` before validating the config: it overrides the redis `cache.url`, including an empty one. Previously the override was applied after validation, so a deploy with only `KN_REDIS_URL` set was refused. The error for a missing URL now names both `REDIS_URL` and `KN_REDIS_URL`. `knext preview` now also applies `KN_REDIS_URL`; before, it ignored it.
