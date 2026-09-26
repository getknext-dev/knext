---
"@getknext/core": patch
---

`kn-next deploy` no longer uploads static assets from a separate host build
when your Dockerfile rebuilds in-image (vinext + object storage). The assets
are now extracted from the image you are about to serve, and the deploy aborts
if the image's server references a client chunk the extracted assets lack.
Previously the two builds could produce different chunk hashes and the app's
main chunk 404'd from the bucket.
