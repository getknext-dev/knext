---
"@getknext/core": patch
---

Bump the scaffolded app's `vinext` pin from `1.0.0-beta.12` to the first stable
release, `1.0.1` (peer ranges unchanged). Apps generated with `kn-next create
--builder vinext` now install vinext `1.0.1`. The compat lane's own deploy
script (`scripts/e2e-deploy-vinext.sh`) stays on `1.0.0-beta.12` for now — it
is inside the v1.0.0-rc.5 credential freeze window and will follow once that
window closes.
