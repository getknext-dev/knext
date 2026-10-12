---
"@getknext/core": patch
---

ISR no longer regenerates on nearly every request while a canary split is active. With two builds serving the same app (`knext rollback --to <revision> --canary <n>`), each build used to discard the revalidate window of pages the other build rendered, so the build that read a page regenerated it and the other build did the same in turn. A build now keeps honouring the other build's window for as long as that build is still serving requests; once the rollout or rollback completes and the replaced build stops serving, its windows stop applying within about two minutes. The handler publishes one short-lived `build-live:<build id>` key per build in your Redis. Pages that use partial prerendering still re-render when the other build wrote the entry last.
