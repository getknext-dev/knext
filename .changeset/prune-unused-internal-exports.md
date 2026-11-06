---
"@getknext/core": patch
---

Internal cleanup with no behaviour change: 40 helpers that nothing outside their own file used are no longer exported from the package's internal modules, and one unused constant (`IMPORT_CONDITIONS` in the sidecar resolver) is removed. No command, flag, config field or public subpath changes.
