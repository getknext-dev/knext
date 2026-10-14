---
"@getknext/core": patch
---

`knext generate` and `knext add` no longer refuse an installed `@getknext/grpc` because the published CLI misread its own version as 0.0.0.
