---
"@getknext/core": patch
---

Fixed a regression in the bundled vinext fix for Nitro RSC dependency bundling (the
port of upstream `cloudflare/vinext#3424`): under the vinext/bun compiled-executable
build target, two deploy-test fixtures measured with 1.3.0-rc.1 broke because the
blanket bundling also swept Next's default server-external packages (including
sqlite3's `bindings` helper and typescript) into the compiled binary. Those packages
now stay external under Nitro too, matching the non-Nitro RSC branch's behaviour, so
the original fix (dependencies of the RSC environment are bundled so a package's
`react-server` export condition is honoured) no longer bundles packages that are not
safe to inline.

Also adds an optional `testFiles` `workflow_dispatch` input to the
`compat-vinext.yml` CI lane for a targeted re-run of specific test files, instead of
waiting on a full 16-shard dispatch. Default is empty, which is unchanged behaviour.
