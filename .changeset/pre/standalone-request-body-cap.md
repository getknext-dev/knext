---
"@getknext/core": minor
---

Request bodies are now capped in-process on the **standalone build** too
(Turbopack or webpack, on Node or Bun, compiled or not) — previously only the
vinext build capped them. The default is **8 MiB** per request body, on every
route. A larger body is answered with `413 Payload Too Large` and the connection
is closed (after discarding, never buffering, the rest of the body for at most
two seconds so an uploading client can read the status); the cap counts the bytes that actually arrive, so a chunked request
with no `Content-Length` is refused too, and an oversized body never reaches
your handler.

**Behaviour change:** if your app accepts uploads larger than 8 MiB through a
route handler, raise the cap before upgrading — set `KNEXT_MAX_REQUEST_BYTES`
(bytes) in the `env` map of `knext.config.ts` or in `spec.env` on the
`NextApp`. `0` removes the cap (logged loudly at start); an invalid value keeps
the 8 MiB default with a warning. The app prints the cap in force on start:
`REQUEST_BYTE_CAP:<bytes> (<source>)`.
