---
"@getknext/core": patch
---

The vinext cache adapter now picks its Redis client per runtime, like the standalone build. New `@getknext/core/internal/vinext-cache-adapter-node` imports `ioredis` directly so a vinext on Node image ships it (it could previously run from memory, losing ISR on scale-to-zero), and `@getknext/core/internal/vinext-cache-adapter-bun` uses Bun's built-in Redis client. New apps are scaffolded with the one matching their runtime; existing apps can switch the specifier in `vite.config.ts`. The generic subpath keeps working. If `REDIS_URL` is set but the client cannot load, startup logs one error.
