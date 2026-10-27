---
"@getknext/core": patch
---

Apps created with `knext create` (and `turbo gen zone`) now pin Next.js `16.4.3`. Every Next.js release up to and including 16.4.0 is affected by GHSA-2464-fhr4-w9xw (critical: unauthenticated remote code execution in the Image Optimization API when SVG files are used), GHSA-673q-mjm6-r5xr (critical: unauthenticated remote code execution in `'use cache'` functions that return typed arrays) and GHSA-p3m5-59mp-jv5r (high: denial of service in the App Router through Server Actions). The fix exists only on the 16.4.x line, so the scaffold moves ahead of the Next.js minor the official compatibility suite has credentialed (16.3); `knext doctor` still reports 16.4 as supported but not yet credentialed.

`knext doctor` now has a Next.js security advisories row: it reports FAIL (exit code 1) when the Next.js your app resolves is affected by one of these advisories, names each one by its GHSA id, and says which version to upgrade to (16.4.1 or later on 16.x, 15.5.28 or later on 15.x). Apps with no resolvable Next.js get no row. The Upgrading docs page has a short upgrade note for existing apps.
