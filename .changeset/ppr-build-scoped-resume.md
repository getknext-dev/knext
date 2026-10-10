---
"@getknext/core": patch
---

After a redeploy, a partially prerendered (PPR) page no longer resumes the previous build's saved state. The Redis cache handler now treats a PPR entry written by a different build as a miss, so the page re-renders instead of logging "Expected the resume to render ... fallback to client rendering" on every request. Regular ISR pages are still shared across builds.
