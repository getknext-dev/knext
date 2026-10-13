---
"@getknext/core": minor
---

Add two commands for zone functions (Beta): `knext add function <name> --lang go|rust` adds a Go or Rust function's contract to your app, and `knext generate` writes the server-only TypeScript clients your zone calls it with. Both come from the optional `@getknext/grpc` package, which is not published yet; until it is installed, both commands say how to install it and exit 1, and `--help` still works. A `@getknext/grpc` whose supported `@getknext/core` range does not include your core version is refused, with both versions named.

`knext generate` runs `buf lint` first; `--check` fails when the committed generated code is out of date, and `--against <baseline>` also runs `buf breaking` against a directory, an image file or a git reference, so removing a field fails the run. `buf` is a pinned binary whose checksum is verified before it runs. Every generated client gives each call a deadline shorter than the zone's request timeout (10 s inside 300 s by default, set in `knext.grpc.json`), retries only side-effect-free reads, never retries a write, requires an idempotency key on every write, and reads the function's address from `<NAME>_SERVICE_URL` at call time. Each contract states a contract version; a function must serve that version or newer, so roll out the function first, then the zone.
