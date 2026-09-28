---
"@getknext/core": patch
---

Internal groundwork for a self-contained single executable: a module that
embeds extra files into a compiled binary at their original relative paths and
verifies they resolve from inside it. Nothing uses it yet; build output and
behaviour are unchanged.
