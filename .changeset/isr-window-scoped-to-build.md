---
"@getknext/core": major
---

On Next.js 16.4, after a deploy the previous build's revalidate window is no longer honoured: the window stored with a cached page is scoped to the build that wrote it, so the new build re-renders those pages instead of serving them fresh for the old window (or forever, for `revalidate: false`).
