---
"@getknext/core": patch
---

The compiled-Bun standalone build no longer fails on Next 16.4. Next's server code requires `../../lib/upgrade/nudge` from a development-only branch, and Next deliberately leaves that file out of the standalone output, so the compile stopped with `Could not resolve`. A relative require that cannot be resolved from inside `node_modules/next/dist/` is now left as a runtime require, which still throws if it is ever reached, exactly as the uncompiled server would. The same miss from your own code or from any other package still fails the build. `kn-next build --verbose` names each such specifier.
