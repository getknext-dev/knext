---
"@getknext/core": patch
---

Node runtime: the ISR and data cache now uses Redis when Redis is configured.

On the standalone node runtime, the runtime image did not include the Redis client. The cache handler fell back to an in-memory store without saying so: cache entries were not shared between pods and were lost on every scale-to-zero. The bun runtime was not affected.

The node runtime image now includes the Redis client. Also, if Redis is configured but its client cannot be loaded, the cache handler now logs one error at startup, starting with `Redis client unavailable`, instead of quietly running from memory.
