---
"@getknext/core": patch
---

`knext build` no longer fails with "'cache.url' is required" for a Redis-cache app when `REDIS_URL` is not set at build time. The URL is now required only at `knext deploy`, and the error says to set `REDIS_URL` when you deploy.
