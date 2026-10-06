---
"@getknext/core": patch
---

The operator now warns when a Knative `DomainMapping` targets a private (cluster-local) app. Knative routes a `DomainMapping` through the public load balancer even when the mapping is labelled cluster-local, so the app silently becomes reachable from the internet. The app now carries a `PrivateExposure` condition and a Warning event naming the mapping. `Ready` is unchanged and the operator never modifies or deletes the `DomainMapping`. Upgrade the operator (its RBAC gains read access to `domainmappings`) before relying on it. The private-apps docs now explain how to expose a private app safely.
