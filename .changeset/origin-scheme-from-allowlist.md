---
"@getknext/core": patch
---

Redirects rewritten by `KNEXT_PUBLIC_ORIGINS` now take their scheme from the matching entry instead of from `X-Forwarded-Proto`. An entry written as `https://app.example.com` always redirects to `https://`, even when the ingress sets `X-Forwarded-Proto: http` or a client forges it, and an `http://` entry redirects to `http://`. An entry with no scheme still means `https`. `X-Forwarded-Proto` is no longer added to `Vary` on those redirects, and the startup log line now lists the full origins.
