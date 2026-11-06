---
"@getknext/core": patch
---

Embedding app data files in a self-contained vinext build now bounds its directory listing: a dense web of symlinked directories (which was listed once per path and could take over a minute) fails the build quickly with a message naming the `outputFileTracingIncludes` pattern. The exact-file-path opt-out of the credential-name check now also works for a package file under pnpm's link layout (an exact path written and really located inside `node_modules`); a path through a link anywhere else, or a file that is itself a link, is still refused. How the name check treats directories below `node_modules` is documented.
