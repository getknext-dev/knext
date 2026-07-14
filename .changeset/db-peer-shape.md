---
"@knext/db": patch
---

Settle the drizzle dependency/peer shape before the first npmjs publish (ADR-0021
amendment, supersedes Open decision 6). `drizzle-orm` is now a hard `dependency`
only — the contradictory optional-peer duplicate is dropped (a dep cannot be both).
`drizzle-kit` remains the sole **optional** peer, consulted lazily only inside
`defineDrizzleConfig()`, which now throws an actionable named-peer error ("install
it as a devDependency") instead of a bare `ERR_MODULE_NOT_FOUND` when it is absent.
The `@knext/db` main entry and the `kn-next db migrate` runner import cleanly
without drizzle-kit installed. The re-exported drizzle-orm range is documented as
part of `@knext/db`'s semver contract. Runtime-neutral.
