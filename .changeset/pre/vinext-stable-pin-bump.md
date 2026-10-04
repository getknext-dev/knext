---
"@getknext/core": patch
---

Bump the scaffolded app's `vinext` pin from `1.0.0-beta.12` to the first stable
release, `1.0.1` (peer ranges unchanged). Apps generated with `kn-next create
--builder vinext` now install vinext `1.0.1`. The compat lane's own deploy
script (`scripts/e2e-deploy-vinext.sh`) reads its `VINEXT_VERSION` default
from `packages/kn-next/package.json` at runtime (#1812) — never a hardcoded
literal — so it tracks this bump (and every future one) automatically,
inside or outside the v1.0.0-rc.5 credential freeze window.
