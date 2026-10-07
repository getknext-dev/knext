---
"@getknext/core": patch
---

New apps scaffolded by `knext create` now declare `sharp` `^0.35.5`, the first release with the fix for GHSA-wq5f-xc86-pv6w. The old `^0.35.2` range already resolved to a fixed version at install time, but the declared floor now excludes the vulnerable releases too.
