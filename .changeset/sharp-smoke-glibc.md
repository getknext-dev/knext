---
"@getknext/core": patch
---

Fixed `knext build --builder vinext` (default `runtime: bun`) failing its post-compile smoke on glibc Linux hosts (e.g. GitHub-hosted `ubuntu-latest` runners, or most Linux dev machines) for any app that depends on `sharp` — which every app `knext create --builder vinext` scaffolds does, for `next/image`. The smoke-only glibc twin binary the smoke compiles for that host now boots without staging sharp's native addon: the smoke only checks health, metrics, and SIGTERM drain (never the `next/image` route), and the binary is deleted immediately after boot, so there was nothing to stage for. The shipped `linuxmusl` binary's sharp staging is unaffected and still verified by the alpine image e2e.
