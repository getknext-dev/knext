---
"@getknext/core": patch
---

With `cdn` set, a response that is not edge-cacheable now leaves your app with no edge directive at all, even one it picked up elsewhere. knext removes `Cloudflare-CDN-Cache-Control`, `CDN-Cache-Control` and the provider's tag header from such a response, and on CloudFront and Azure Front Door any `s-maxage` in `Cache-Control`. Before, a middleware or `proxy` rewrite to an absolute URL on another origin (for example `localhost` while the server listens on `127.0.0.1`) was fetched by Next.js and its response headers, edge directive included, were copied onto a path your middleware covers, so a CDN could serve one visitor's variant or protected page to another. Responses that are edge-cacheable are unchanged, and without `cdn` nothing changes.
