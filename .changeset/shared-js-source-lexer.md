---
"@getknext/core": patch
---

The static-export check on `next.config` now reads comments the way the rest of knext's source-text checks do. Previously a regular expression containing `//` (for example `/^https?:\/\//`) earlier on the same line as `output: 'export'` was read as the start of a comment, so the export was missed and the build carried on. The check also now treats a block comment between the key and the value (`output: /* note */ 'export'`) as whitespace. The check still reads `next.config` as text, so a value computed at runtime is not detected.
