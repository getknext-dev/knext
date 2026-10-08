---
"@getknext/core": patch
---

A vinext app now scrolls and focuses after a client navigation the way Next.js 16.3 does. Focus stays on the link you clicked instead of jumping to the new page, the page is measured against the root `scroll-padding-top` so a sticky header no longer hides the top of it, a stylesheet React hoists into `<head>` no longer stops the scroll to the top, and an intercepted route (a modal in a parallel slot) no longer scrolls or blurs the page underneath. This is a bundled fix for vinext 1.0.1 until a vinext release includes it.
