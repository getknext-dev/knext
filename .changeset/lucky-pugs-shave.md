---
"@getknext/core": patch
"@getknext/lib": patch
"@getknext/db": patch
---

Version the three published packages in lockstep.

`@getknext/core` depends on `@getknext/lib` and `@getknext/db`, so the three have always had to
ship as a set — but that was a documented intention, and the tree had already drifted to three
different numbers. They are now a Changesets `fixed` group, so every release moves all three to the
same version, and a guard fails if they diverge or if a fourth publishable package appears.

No API change. From this release on, pinning `@getknext/core@x.y.z` pins the whole set.
