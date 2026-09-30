---
"@getknext/core": patch
---

Mark the `selfContained` config key / `knext build --self-contained` flag and
the `preview`/`loadtest` directly-runnable CLI entries as **experimental** —
they are excluded from the 1.0 semver commitment and may change in a minor
release. `docs/PUBLIC_API.md` now documents this carve-out under
"Experimental surfaces"; no behaviour changed.
