---
"@getknext/core": patch
---

Fixed `knext build --builder vinext` (default `runtime: bun`) failing its post-compile smoke on glibc Linux hosts (e.g. GitHub-hosted `ubuntu-latest` runners, or most Linux dev machines) for any app that depends on `sharp` — which every app `knext create --builder vinext` scaffolds does, for `next/image`. The smoke-only glibc twin binary the smoke compiles for that host now stages sharp's real glibc native addon pair before boot, the same way the shipped `linuxmusl` binary already stages its own (fetched from the lockfile-pinned version when the build host's own install does not carry it). The shipped binary's own sharp staging is unaffected and still verified by the alpine image e2e.
