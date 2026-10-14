# @getknext/ffi (Beta)

In-process Rust for knext zones: call a Rust function from a Server Action or route handler in
the same process, through Bun's `bun:ffi`, with a typed, `server-only` TypeScript wrapper
generated from the library itself. Not published yet.

**Beta, Bun only.** `bun:ffi` is experimental upstream, and only Bun has it: an app that opts in
cannot use the Node runtime. For Node, or for work that should scale, fail or deploy on its own,
use a zone function (`knext add function`).

This package provides the `knext ffi` commands. `@getknext/core` owns the `knext` binary and
loads this package only when `knext ffi` is typed:

- `knext ffi init` — write `knext.ffi.json` and a starter `rust/` crate.
- `knext ffi generate` — build the crate for this machine and write the typed wrapper.
- `knext ffi check` — the same, but fail if the committed wrapper is out of date (CI).
- `knext ffi build` — cross-build the library for the image (run by `knext build`).

## Layout

- `src/config.ts` — `knext.ffi.json` (version 1: `crate`, `out`).
- `src/manifest.ts` — the scanner: reads the `KNEXTFFI1` records the `knext-ffi` macros embed in
  the library, byte for byte, without loading it; the transitive schema hash.
- `src/render.ts` — `renderModule`, the pure emitter of the wrapper module (also the entry the
  image build's drift check uses: `@getknext/ffi/render`).
- `src/generate.ts`, `src/output.ts`, `src/cargo.ts` — `generate` / `check`.
- `src/init.ts`, `templates/init/` — `init`.
- `fixtures/abi-v1/fixture.c` — the ABI implemented in C, so the generated module's loader and
  calls are tested against a real shared library.
- `fixtures/app` — the golden generated module, type-checked with Node types only.
