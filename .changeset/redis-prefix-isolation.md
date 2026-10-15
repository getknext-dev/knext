---
"@getknext/core": minor
---

Keep apps that share one Redis out of each other's cache. An app that set no `cache.keyPrefix` used the shared prefix `kn-next`, so every such app on one Redis read the others' entries and received their invalidations, and after a long Redis outage one app's cache clean-up deleted every other app's cache too, per-user `'use cache'` entries included.

- The operator now gives every Redis-cached app without `cache.keyPrefix` its own prefix, derived from the app's namespace and name. A `REDIS_KEY_PREFIX` set in `env` or `secrets.envMap` still wins. On upgrade, such an app rolls out a new revision under its new prefix and starts with an empty cache; the keys it left under `kn-next:` expire on their own.
- The outage clean-up of ISR and `'use cache'` entries no longer runs under `kn-next`, or under a prefix inside it such as `kn-next:cache`: it logs an error and leaves the app's entries until they expire. The `'use cache'` metric gains the event `tags_collapse_refused`.
- Deleting an app removes only the Redis keys that literally start with its prefix and `:`. Characters such as `*`, `?` and `[` in `cache.keyPrefix` are no longer read as wildcards, and the operator never deletes keys under `kn-next:`, even for an app whose `cache.keyPrefix` is `kn-next` or sits inside it.
- `knext doctor` warns when two apps on the cluster share a Redis key prefix, when one prefix sits inside another's, or when an app uses `kn-next` or a prefix inside it.
