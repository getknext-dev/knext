---
"@getknext/core": patch
---

An absolute-URL `assetPrefix` with a path, such as `https://cdn.example.com/assets`, now works on the vinext target with both runtimes. The app also serves its client bundles at `/assets/_next/static/...` on its own origin, as `next start` does, so a CDN or proxy in front of it can fetch them from there. Before this, those requests returned 404.
