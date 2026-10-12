# @getknext/grpc (Beta)

Zone functions for knext: Go or Rust backend functions a Next.js zone calls over Connect,
scale-to-zero like the zone itself. Not published yet.

This package provides two `knext` commands. `@getknext/core` owns the `knext` binary and loads
this package only when one of them is typed:

- `knext add function <name> --lang go|rust` — add a function's contract to the app.
- `knext generate [--check] [--against <baseline>]` — lint the contracts, optionally run
  `buf breaking` against a baseline, and write the server-only clients.

It also ships the runtime those generated clients import (`@getknext/grpc/runtime`) and the
contract skew rule (`@getknext/grpc/skew`): a function must serve a contract version greater than
or equal to its zone's, so roll out the function first, then the zone.

See the CLI reference in the knext docs for the generated-client policy (deadline, read-only
retries, idempotency keys).

## Layout

- `src/buf.ts` — the pinned buf binary, verified against a sha256 per platform before it runs.
- `src/generate.ts`, `src/plugin.ts` — `knext generate`: buf builds, protoc-gen-es and
  protoc-gen-knext run in-process, output is compared or written.
- `src/policy.ts`, `src/runtime.ts` — the client policy and the runtime that enforces it.
- `src/add-function.ts` — `knext add function`.
- `src/baseline.ts` — `--against` resolution, including the seam for a deployed baseline.
- `proto/knext/v1/options.proto` — the knext options contract apps import.
- `fixtures/zone` — the fixture app whose committed output CI checks with `generate --check`.
