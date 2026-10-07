---
"@getknext/core": patch
---

The vinext fixes knext bundles now match the upstream maintainers' latest versions: repeated slashes and backslashes in a request path redirect (`308`) like Next.js, a custom `next/image` loader also serves `fill` images and skips inline sources, `outputFileTracingIncludes`/`outputFileTracingExcludes` follow Next.js route and glob matching, and `x-nextjs-cache: MISS` on `/_next/image` is sent only with the image bytes. Two bundled fixes were dropped because vinext 1.0.1 already behaves that way or upstream declined them.
