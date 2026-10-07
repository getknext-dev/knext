---
"@getknext/core": patch
---

`knext deploy` and `knext preview` of a vinext app on Node from a glibc or macOS host no longer put the host's `sharp` binary into the alpine image; the image now gets the `sharp` build that matches it.
