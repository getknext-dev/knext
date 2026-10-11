---
"@getknext/core": minor
---

`knext doctor` now warns when your `next.config` enables `cacheComponents`. Server-side `'use cache'` entries are per-pod on knext today: they are not shared across pods and do not survive scale-to-zero. The warning does not fail `doctor`. The ISR and caching docs describe the behaviour.
