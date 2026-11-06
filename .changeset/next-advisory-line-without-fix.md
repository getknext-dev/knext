---
"@getknext/core": patch
---

The internal check that decides whether a `next` minor has no fixed release now also reports a minor whose last patch is affected and whose fix ships only on the next minor. Today's advisory table is unaffected, so `knext doctor` output is unchanged; this closes a gap that would have let doctor recommend such a minor if a future advisory ended at a minor's last patch.
