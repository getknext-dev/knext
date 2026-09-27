# Patches applied on top of `../UPSTREAM_SHA`

Empty on purpose until an upstream fix needs verifying ahead of a Bun release.

- Format: `git format-patch` output against `UPSTREAM_SHA`, applied with `git am` in filename order.
- One patch per upstream issue: `<nnn>-<upstream-issue>-<slug>.patch`,
  e.g. `001-bun-44059-compile-include.patch`.
- The patch header (the commit message `git format-patch` writes) MUST name the upstream issue or PR
  (`oven-sh/bun#NNNNN`) and the F1 shim-registry id it retires (`knext-shim: <id>`).
  `infra/bun-base/build.sh` refuses a patch missing either line.
- Delete the patch in the same PR that bumps `UPSTREAM_SHA` past the upstream merge.
