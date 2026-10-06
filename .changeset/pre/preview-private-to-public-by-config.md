---
"@getknext/core": patch
---

A private preview can now be made public by changing the branch's config. Setting
`networking: { visibility: "public" }` explicitly in `knext.config.ts` is accepted on the next
preview deploy; omitting the `networking` block is still refused so an accidental removal cannot
quietly expose a private preview. The refusal message now names both ways forward.
