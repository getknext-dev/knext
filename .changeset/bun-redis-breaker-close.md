---
"@getknext/core": patch
---

Fix a Redis connection leak in the cache handler on Bun. When Redis faulted and the cache handler stopped using it for a cooldown, Bun's built-in Redis client was dropped without being closed, so it kept its connection open and kept reconnecting while a new client was built. Every fault left one more connection open, so a Redis that kept failing and recovering could pile up connections. The dropped client is now closed, as it already was on Node. If a client ever cannot be closed, the handler logs that once instead of failing silently.
