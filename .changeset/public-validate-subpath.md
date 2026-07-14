---
"@knext/core": minor
---

Add a public `@knext/core/validate` subpath.

`validateConfig` (and its `ConfigValidationError` result type) are now a
supported public import. Use them as a config-quality gate in your own CI to
validate a `kn-next.config.ts` against the exact rules the deploy step applies,
before a bad config reaches the cluster:

```ts
import { validateConfig, ConfigValidationError } from '@knext/core/validate';
```

The module is pure — importing it runs no I/O and never exits the process — so
it is safe to pull into your own build/test process. The previous
`@knext/core/internal/cli-validate` subpath remains for internal CLI wiring but
carries no stability guarantee; prefer the public `@knext/core/validate`.
