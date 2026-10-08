---
"@getknext/core": patch
---

On the vinext target, in an app with both `app/` and `pages/`, a Pages route that returns `notFound` (from `getStaticProps` or `getServerSideProps`, or a path a `fallback: false` page does not list) now renders `app/not-found`, as Next.js does, instead of `pages/404`. The 404 keeps the Pages route's `Cache-Control`.
