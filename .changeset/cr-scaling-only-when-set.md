---
"@getknext/core": patch
---

The `NextApp` that `knext deploy` applies no longer always carries `spec.scaling.minScale` and `spec.scaling.maxScale`. A `minScale` of 0 (scale to zero) is the field's unset value, so it is now left out; `spec.scaling` is left out entirely when `knext.config.ts` sets nothing scaling-related, and the operator's own default of 10 maximum replicas applies. Whenever a `spec.scaling` block is written it still carries a `maxScale` (yours, else 10), because the operator reads a present block's `maxScale` literally and 0 means unbounded.

Your app's effective minimum and maximum scale do not change, and an older operator reads the same values the same way; the `NextApp` object is simply smaller. Only what you set is written, so a cluster-wide default can never be shadowed by a value you did not choose.
