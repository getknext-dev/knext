#!/usr/bin/env bash
#
# app-id.sh — the identity BOTH arms of a build-target A/B must agree on.
#
# ADR-0036 condition A1 is "same application on both arms, asserted by image
# digest, not by inspection". Two build targets produce two digests by
# construction, so run.sh compares a LABEL instead (`--app-id-label`). That only
# works if the label is computed the same way on both sides — which is why this
# lives in one file that every build recipe sources, rather than being copied.
#
# TWO THINGS THIS DELIBERATELY DOES NOT DO, both of which made A1 unsatisfiable:
#
#   1. NO TARGET PREFIX. `build.sh` used to emit `bun-exec-<sum>`. A node arm
#      computing `node-<sum>` over the identical application would then differ
#      from the bun arm on every comparison, so the gate could never pass no
#      matter how identical the app was. The prefix encoded the TARGET into a
#      value whose entire job is to be target-independent.
#
#   2. NO BUILD-TARGET FILES IN THE HASH. `build.sh` used to fold in
#      `vite.config.ts`, `runtime-contract.mjs` and `knext-bun-entry.mjs`. Those
#      describe HOW the app is built, not WHAT it is, and the node arm has none
#      of them — so including them guarantees the two arms disagree. `next.config.ts`
#      is excluded for the same reason, from the other side.
#
# WHAT IS HASHED: `app/` (the application) and `package.json` (its dependency
# surface, shared by both arms). Content-addressed, so it does not depend on git
# state or on anyone remembering to bump a version.
#
# CONSEQUENCE, stated because it is a real trade: a change to a build config no
# longer changes the app id. That is correct for A1 — the arms are SUPPOSED to
# differ in build config — but it means the id alone does not tell you the
# artifact was rebuilt. `dev.knext.build.command` carries that, which is why both
# labels exist and why A4 asks for build provenance separately from A1.
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

sum=$( { find app -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 2>/dev/null
         shasum -a 256 package.json 2>/dev/null
       } | shasum -a 256 | cut -c1-16 )

printf 'app-%s' "${sum:-unknown}"
