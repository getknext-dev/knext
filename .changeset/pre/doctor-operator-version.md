---
"@getknext/core": patch
---

`knext doctor` now has an "Operator version" row. It reads the installed operator's release version (the `app.kubernetes.io/version` label on the manager Deployment, falling back to a semver image tag), prints it with the image digest, and warns — without failing the preflight — when the operator is older than the CLI (the operator's major.minor must be equal or newer), when the majors differ, when the operator is an unreleased build, or when it predates operator versions and reports none. Operator releases (`operator-vX.Y.Z`) now also publish a digest-pinned `install-vX.Y.Z.yaml` alongside `install.yaml`, so an operator version can be pinned, upgraded to and rolled back to by name; `operator-latest` is unchanged.
