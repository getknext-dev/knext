---
"@getknext/core": minor
---

Zone functions (Beta): generated calls now carry a per-call identity token instead of being refused. Each call sends `authorization: Bearer <token>`, an Ed25519-signed token that names the calling zone, the one function and RPC it is for, and the user your `authorize()` hook returned (empty for an `AUTH_PUBLIC` read), and expires after 60 seconds. It is signed with the zone's key, read from the operator's mount at `/var/run/knext/signing-key` (never from an environment variable) and re-read when it rotates, with the zone's identity from `KNEXT_ZONE_ISSUER`. A call is refused before it leaves the zone when the key or the identity is missing, when `<NAME>_SERVICE_URL` is not the function's cluster-local address, or when the function is in another namespace. `knext generate` now also refuses an `authorize` module that does not export `authorize` by name.
