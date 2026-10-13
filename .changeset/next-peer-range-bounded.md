---
"@getknext/core": minor
---

The `next` peer range is now bounded to the Next.js minors knext has compatibility evidence for: `>=16.4.0 <16.5.0` (was `>=16.4.0`). A newer Next.js minor shows as a peer-dependency warning until a knext release admits it. `knext doctor` also gains a `next-minor` row that warns when the installed Next.js is inside the range but not one of the covered minors (`16.4`), or is outside the range.
