---
"@getknext/core": patch
---

ISR pages generated at request time (for example a dynamic route without `generateStaticParams`) are
no longer served as stale on the first request after the app scales up from zero. The Redis cache
handler now records which build wrote each entry, along with its revalidate window, and gives that
window back to Next.js when the same build reads the entry. A cached page inside its window is then
a cache hit after a cold start instead of triggering a regeneration. Entries written by a previous
deploy are still revalidated by the new build as before.
