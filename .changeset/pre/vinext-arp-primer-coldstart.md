---
"@getknext/core": patch
---

Fixed a cold-start regression on the vinext build target (both the compiled single-executable and the Node runtime): on some clusters, apps deployed with `build: 'vinext'` woke up to around 8 seconds slower than the standalone target, because the networking-stall mitigation described in the scale-to-zero docs was not wired into this build target. It now sends the same best-effort outbound packet as early as possible at process start, like every other knext runtime. No configuration changes needed; opt out with `KNEXT_ARP_PRIMER=0` if you need to.
