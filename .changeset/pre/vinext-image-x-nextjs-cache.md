---
"@getknext/core": patch
---

Bundled vinext fix: `/_next/image` responses now carry `x-nextjs-cache: MISS` on every successful image response, like Next.js. Error responses carry no header.
