---
"@getknext/core": minor
---

Announcing what changes in 2.0, so you can prepare during 1.x.

- **2.0 floors.** knext 2.0 will require Next.js 16.4.0 or newer (stable since 2026-10-06) and Node.js 24 or newer. Releases in the 1.x line keep their current floors.
- **The `kn-next` command is removed in 2.0.** Use `knext` instead; it takes the same command and flags. The deprecation notice `kn-next` prints now says it will be removed in 2.0.
- **Two cache-handler test helpers are deprecated.** `__resetEnvForTests` and `__setRedisClientForTests` on `@getknext/core/adapters/cache-handler` are marked `@deprecated`: they are removed in 2.0 and are test-only. Your editor now shows the strikethrough; nothing changes at runtime.
