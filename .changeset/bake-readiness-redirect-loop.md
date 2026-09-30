---
"@getknext/core": patch
---

The standalone-node compile-cache bake no longer fails `docker build` with "standalone server did not answer" for apps whose routing redirects or rewrites the warm path. Readiness now waits for the server to accept a connection rather than for an HTTP answer through the app's middleware, redirects on the warm path are followed by hand (a redirect loop is reported as the non-2xx status it is, instead of a timeout), and the bake's own requests no longer go through the `fetch` that Next.js patches inside the server process. The bake also never follows a redirect off its own origin — a warm path that redirects to a third-party host (for example an auth middleware bouncing to an external IdP) is reported as the redirect it is, never fetched, so the bake can't be graded on a third party's response or make an unbounded outbound request during `docker build`.
