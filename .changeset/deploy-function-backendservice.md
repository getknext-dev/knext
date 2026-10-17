---
"@getknext/core": minor
---

`knext deploy function` applies a zone function's `BackendService` to the cluster. It comes from the optional `@getknext/grpc` package, so core only loads it when you type the command. The resource is checked first with a server-side dry run under strict validation, so a cluster whose `BackendService` CRD is older than the CLI is told so before anything changes (upgrade the operator first). The apply then passes `--validate=strict`. The command never runs Knative's `func` or `kn` tools, and it does not build or push the image: pass the digest-pinned image you already built with `--image`.
