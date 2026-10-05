---
"@getknext/core": minor
---

Add a `networking.visibility` option to `knext.config.ts` and a matching `knext deploy --private`
flag, so an app can be deployed with its route reachable only from inside the cluster instead of
always getting a public one. This is the platform way to deploy an app whose mutating endpoints
(uploads, deletes, admin actions) have no auth of their own, without relying on a manual label the
next deploy would silently undo.

Leaving `networking` unset keeps today's behavior exactly — a public route, as before. Requires an
operator (and its CRD) that supports this field; upgrade the operator before deploying with a CLI
that sets it, or the deploy is rejected with a clear schema error. See the "Private apps" docs page
for how to deploy one and how to reach it afterward.

`--private` is a per-run override, not a persistent setting, so a later plain `knext deploy` with
no flag now REFUSES to silently make a currently-private app public again — it names the new
`knext deploy --public` flag as the only way to confirm that downgrade. The same guard now covers
`knext preview deploy` too, which reuses one CR name across every commit of a PR: previews have no
`--public` override, so the fix there is always a `knext.config.ts` change on that PR's branch.

Also: `knext deploy --image <ref>` (deploying a pre-built, digest-pinned image) no longer requires
a lockfile in the current directory. It already skipped the build; it was incorrectly still
checking for one first.

Escalation trigger acknowledged: this is an additive, optional field on both the deployment
resource the operator reconciles and the `knext.config.ts` schema / CLI surface — unset is
byte-identical to today's behavior.
