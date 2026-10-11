---
"@getknext/core": minor
---

Declare your app's public hostnames once, and redirects built from `request.url` use them. Add `networking.publicHosts` to `knext.config.ts`, for example `publicHosts: ["app.example.com", "www.example.com"]`, primary domain first. The CLI sends it as `spec.networking.publicHosts` on the NextApp resource, and the operator turns it into the `KNEXT_PUBLIC_ORIGINS` allowlist the runtime already reads, so you no longer set that variable by hand. Entries must be lowercase hostnames with no scheme, port, path or wildcard; `knext deploy` checks them before building, and the cluster rejects anything else. An empty or missing list changes nothing. A `KNEXT_PUBLIC_ORIGINS` you set yourself under `env` or `secrets.envMap` still wins, so existing setups keep working. This is a new field on the NextApp resource, so upgrade the operator first, then the CLI. A CLI that sends `publicHosts` to an older operator is stopped by the deploy preflight, which names the field.
