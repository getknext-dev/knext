---
"@getknext/core": patch
---

`knext deploy` now fails when the operator holds your app change instead of reporting success. If the platform's defaults make the app's effective spec invalid (for example the connection budget is exceeded), the operator keeps the previous version serving and marks the app not Ready. Deploy now exits non-zero with the operator's message, which names the field, and tells you to raise the platform budget or lower `maxScale` / `poolMax`.
