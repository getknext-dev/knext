---
"@getknext/core": patch
---

A Pages Router app on the vinext target now loads `_document` first, then `_app`, then the page modules, matching the order Next.js evaluates them in, so side effects at the top of a custom document run before the app's and the page's.
