---
"@getknext/core": patch
---

On Next.js 16.4, a route with `dynamicParams = false` that rejects a path now lets the request fall through to a less specific route, instead of answering the closed route's 404. For example, with `app/overlap/[slug]` (only `known` generated) beside `app/overlap/[...rest]`, `/overlap/unlisted` now renders the catch-all. Paths that nothing else matches still 404.

`knext build` and `knext deploy` already cleared the build-time adapter from the server's runtime config on Next.js 16.3 and earlier; they now do so on every Next.js version. Behaviour on 16.3 is unchanged.
