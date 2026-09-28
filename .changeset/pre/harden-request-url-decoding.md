---
"@getknext/core": patch
---

Harden request URL decoding in the scaffolded `vinext` server entries. A request
whose path is not valid percent-encoding is now answered with `400 Bad Request`
before routing, and any other failure on the request path becomes a plain `500`
response instead of an error page or a process exit. The change lives in the
scaffolded `runtime-contract.mjs`, `knext-bun-entry.mjs` and
`knext-node-entry.mjs`; existing apps pick it up by copying those files from a
fresh `kn-next create --builder vinext` (`kn-next doctor` flags a stale Node
entry).
