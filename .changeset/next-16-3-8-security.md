---
"@getknext/core": patch
"@getknext/lib": patch
"@getknext/db": patch
"kn-next": patch
---

Security: new apps now scaffold with Next.js 16.3.8. The default and vinext builder templates move from 16.3.6. Next.js 16.0.0 through 16.3.7 have a high-severity server-side request forgery in Image Optimization (GHSA-cjq9-62q9-8jv4), fixed in 16.3.8. If you scaffolded an app from an earlier release candidate, upgrade it with `npm install next@16.3.8` (or a later 16.3.x). The compatibility credential suite now runs against Next.js 16.3.8.

Next.js 16.3.7 and later scope every cached entry to its source route, so cache keys now start with `/route-cache/`. The knext cache handler treats every key as an opaque string, so it needs no change. After upgrading an existing app, entries written to Redis under the old key shape (by Next.js before 16.3.7) are never read again and stay in Redis until their TTL expires; the affected pages are regenerated on first request.
