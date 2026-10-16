---
"@getknext/core": patch
---

The cluster now refuses a `cache.keyPrefix` that is longer than 63 characters, contains whitespace or one of the Redis pattern characters `* ? [ ] \`, or is the shared fallback prefix or sits inside it (`kn-next:*`). `knext deploy` applies the same check before it builds, and `knext doctor` names any app whose stored prefix the cluster now refuses. Upgrade the operator and its CRD first, then the CLI. Kubernetes 1.30 is now the supported server floor: on 1.28 and 1.29 an app whose stored prefix is refused cannot take its next spec change until the prefix is fixed.
