---
"@getknext/core": patch
---

Send one best-effort outbound UDP datagram to the pod's default gateway as early as possible at process start, in both runtime entries (the standalone supervisor and the compiled standalone-on-Bun executable). On some clusters a node can briefly be unable to reach a freshly-started pod until it sends its own first outbound packet; this mitigates the resulting cold-start stall without requiring any extra cluster privilege or feature flag. Opt out with `KNEXT_ARP_PRIMER=0`.
