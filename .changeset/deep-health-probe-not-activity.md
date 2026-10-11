---
"@getknext/lib": patch
"@getknext/core": patch
---

The deep-health probe no longer keeps a scale-to-zero database awake. Its own `SELECT 1` was counted as the app using the database, so with a scrape interval shorter than the 45 second activity budget every scrape re-opened the gate and the database never slept while the pod was up. The probe now runs outside activity tracking, so once the app has been idle past the budget, scrapes stop probing. Because the deep-health gauge is now served on the app metrics port, which other namespaces can read, concurrent scrapes also share one probe and a result is reused for 10 seconds, and the app-side metrics body is read with a 256 KiB cap.
