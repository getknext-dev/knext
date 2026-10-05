---
"@getknext/core": patch
---

Bundles a fix ahead of its upstream vinext release (`cloudflare/vinext#3689`):
when a server action's `redirect()` is invoked through the client-side router
(a fetch request, not a plain `<form>` submission), the response now always
answers HTTP `200`, matching current Next.js. It previously fell back to
`303` unless the redirect target had already been forwarded, was an
ancestor/stale-sibling route, or ran on a different runtime than the current
route.

This only changes the response's status code — the redirect target still
reaches the browser the same way it always did, through the
`x-action-redirect` header (no `Location` header is set either before or
after this fix), so no open-redirect behaviour is introduced. A no-JS
`<form>` submission's redirect is unaffected and still answers `303`.
