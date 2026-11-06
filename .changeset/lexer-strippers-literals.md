---
"@getknext/core": patch
---

`knext build` and `knext doctor` no longer misread `next.config` when a string, template or regex literal contains comment markers or brackets. The static-export check, the tracing-root detection and the `use cache` check now share one JavaScript lexer, so a `//` inside a URL string or a `}` inside a literal can no longer hide a real setting or invent one.
