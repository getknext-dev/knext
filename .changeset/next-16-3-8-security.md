---
"@getknext/core": patch
"@getknext/lib": patch
"@getknext/db": patch
"kn-next": patch
---

Security: new apps now scaffold with Next.js 16.3.8. The default and vinext builder templates move from 16.3.6. Next.js 16.0.0 through 16.3.7 have a high-severity server-side request forgery in Image Optimization (GHSA-cjq9-62q9-8jv4), fixed in 16.3.8. If you scaffolded an app from an earlier release candidate, upgrade it with `npm install next@16.3.8` (or a later 16.3.x).

The Next.js cache handler now follows Next 16.3.7+, which scopes cached entries to their source route (cache keys now start with `/route-cache/`): the revalidate window handed back to Next after a scale-to-zero wake is filed under that exact key, so ISR pages generated at request time still read fresh after a wake. After upgrading, cache entries written under the old key shape (before Next 16.3.7) stay unread in Redis until their TTL expires.
