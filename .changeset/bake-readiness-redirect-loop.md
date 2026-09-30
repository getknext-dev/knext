---
"@getknext/core": patch
---

The standalone-node compile-cache bake no longer fails `docker build` with "standalone server did not answer" when the app answers its warm path with a redirect. Readiness now counts any HTTP response as a live server, redirects are followed by hand (a redirect loop is reported as the non-2xx status it is, instead of a timeout), and the bake's own requests no longer go through the `fetch` that Next.js patches inside the server process.
