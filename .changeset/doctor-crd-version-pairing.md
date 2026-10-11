---
"@getknext/core": patch
---

`knext doctor` now pairs the CLI with the cluster by CRD API version instead of by package major. The **NextApp CRD** row reads the versions the installed CRD serves and compares them with the `apiVersion` your CLI emits (`apps.kn-next.dev/v1alpha1`): it passes when that version is served, including when the CRD serves several versions, and fails with "upgrade the operator first (operator, then CLI)" when it is not. A CRD doctor cannot read fails rather than passing.

The **Operator version** row is now informational. It still warns when the operator's minor is older than the CLI's within the same major, but a different major is no longer a warning, so a CLI on a new major no longer reports a false warning against an operator that keeps its own version line.
