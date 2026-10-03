---
"@getknext/core": patch
---

Remove `scaling.containerConcurrency: 100` from the scaffold templates used by `knext create`
(both the standalone/turbopack and vinext builder templates). The operator's default of `20`
now applies, which is the concurrency the 8 MiB request-body cap is sized for — at `100`,
concurrent large uploads could buffer enough bytes to OOM-kill a 1Gi pod.

Apps created before this change contain the `containerConcurrency: 100` line in their
`knext.config.ts`; delete it, or set it to `20` or lower.
