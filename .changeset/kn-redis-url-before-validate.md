---
"@getknext/core": patch
---

`knext deploy` now honours `KN_REDIS_URL` when the config's redis `cache.url` is empty. Previously the override was applied after validation, so a deploy with only `KN_REDIS_URL` set was refused. The error for a missing URL now names both `REDIS_URL` and `KN_REDIS_URL`.
