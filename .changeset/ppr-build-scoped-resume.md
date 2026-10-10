---
"@getknext/core": patch
---

After a redeploy, a partially prerendered (PPR) page no longer resumes the previous build's saved state. The Redis cache handler now treats a PPR entry written by a different build as a miss, so the page re-renders instead of logging "Expected the resume to render ... fallback to client rendering" on every request. Regular ISR pages are still shared across builds.

A build is identified by `.next/BUILD_ID`; where that is missing or is Next's constant id (vinext, `knext preview`, images built outside knext), the handler uses `KNEXT_BUILD_ID`, then `NEXT_DEPLOYMENT_ID`. Only when none of the three is available can it not tell builds apart, and a PPR entry is then served as before (the original symptom remains in that case).

The handler already skipped cache-control windows recorded by another build, so the same rule now covers both the saved state and the cache window.
