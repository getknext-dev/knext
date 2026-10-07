---
"@getknext/core": patch
---

On the vinext target, text followed by a `next/dynamic` component now server-renders like Next.js: the bundled vinext fixes no longer leave an extra `<!-- -->` marker between the text and the component's Suspense boundary. The dynamic component's preload hints are still emitted.
