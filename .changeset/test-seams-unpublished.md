---
"@getknext/core": major
---

Test-only helpers are no longer part of the published package. `@getknext/core/adapters/cache-handler` no longer exports `__resetEnvForTests`, `__setRedisClientForTests` or any other `__`-prefixed helper, and `@getknext/core/internal/logger` no longer exports `__resetLoggerForTests`. They were marked `@deprecated` in 1.x and announced as removed in 2.0. Nothing changes for apps that use the handler the documented way (`export { default } from '@getknext/core/adapters/cache-handler'`): the default export and the `CacheHandler`, `ioredisClient` and `nativeRedisClient` named exports are unchanged.
