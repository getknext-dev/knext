---
"@getknext/core": patch
---

`knext deploy --dry-run` now writes its log lines to stderr, so stdout carries only the rendered `NextApp` YAML and `knext deploy --dry-run | kubectl apply -f -` works. `knext db bind --dry-run` does the same for the patch it prints.
