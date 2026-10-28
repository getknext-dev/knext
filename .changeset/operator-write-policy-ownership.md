---
"@getknext/core": patch
---

The operator's Secret and ConfigMap write policy now also binds each write to ownership. The operator may create, update or delete its per-zone signing-key Secret and JWKS ConfigMap only when the object carries a controller `ownerReference` to the zone's `NextApp`, and an update cannot change that reference. A foreign object under an allowed name is refused by the API server. The operator's own writes are unchanged: it already sets the reference at create. `knext doctor` expects the new policy, so a cluster still running the policy from an earlier bundle reports the write-policy row as a `WARN` (`PolicyModified`) until the operator bundle is reapplied.
