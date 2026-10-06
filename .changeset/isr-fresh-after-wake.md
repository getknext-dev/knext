---
"@getknext/core": patch
---

ISR pages generated at request time (for example a dynamic route without `generateStaticParams`) are
no longer served as stale on the first request after the app scales up from zero. The Redis cache
handler now gives Next.js back each entry's stored revalidate window, so a cached page inside its
window is a cache hit after a cold start instead of triggering a regeneration. Pages with
`revalidate = false` keep their window across restarts as well.
