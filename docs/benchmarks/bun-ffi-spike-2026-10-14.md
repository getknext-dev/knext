# `bun:ffi` in-process Rust spike (#2315, ADR-0069)

Date: 2026-10-14. Throwaway spike, measure-first; **no spike code ships** (it lives in the session
scratchpad). Input to `docs/adr/0069-bun-ffi-inprocess-rust.md`. Builds on the 2026-10-13
research for #2315 (local note `.claude/research/native-rust-on-bun-2026-10-13.md`, summarised in
the issue), whose napi-rs recommendation the founder overruled in favour of `bun:ffi`.

Tags: **[measured]** run here; **[read]** read in a doc or source; **[inferred]** reasoning only.

## Setup

- Host: Apple M1 Pro, macOS (Darwin 27.0.0). The machine was shared with other agents during the
  run, so nanosecond numbers vary up to ~2x between runs; read them as orders of magnitude.
- Bun `1.4.2+744846f84`, Node v24.14.0, rustc/cargo 1.97.1, Next 16.3.8, React 19.2.8,
  vinext 1.1.0 + vite 8.2.2.
- Rust: syn 2.0.119, quote 1.0.47, proc-macro2 1.0.107, serde 1.0.229, serde_json 1.0.154
  (crates.io reachable). Release profile `opt-level = 3, lto = true, codegen-units = 1, strip = true`.
- Two parts: **A (core)** — a real `#[export]`/`#[record]` proc macro, a `cdylib` carrying its own
  manifest, a byte-scanning generator, the generated wrapper, leak/panic/overhead/single-exec/Worker
  tests. **B (Next.js)** — a Server Action on Bun calling Rust through `bun:ffi`, with Turbopack and
  webpack, and the import-form matrix.

## A. The ABI, as run

`#[no_mangle] extern "C" fn __knext_ffi_<name>(args…, out: *mut [u64; 2]) -> i32`; status 0 OK,
1 `Err` (UTF-8 message), 2 panic (message). Scalars written at offset 0 of `out` (little-endian,
native width); buffers are a `Box<[u8]>` with (ptr, len) in `out[0..2]`, freed by
`__knext_ffi_free(ptr, len)`; an empty return is `(0, 0)`, not allocated, not freed. String/bytes/
record arguments are `(ptr, usize len)`, with NULL/0 handled. Records are JSON; `i64`/`u64` record
fields are decimal strings on the wire and `bigint` in TS. Bodies run inside `catch_unwind`;
`#[cfg(panic = "abort")] compile_error!`. Manifest: one exported static per export/record holding
`KNEXTFFI1` + JSON + NUL. **[measured]** No ABI change was needed. ADR-0069 D4 adds, after the
spike, the `knext_ffi_v1_` prefix and a signature hash in each symbol name.

Two generator rules the spike found **[measured]**:

1. **Take `ptr()` of an explicit `ArrayBuffer`.** The first draft did `OUT = new BigUint64Array(2);
   OUT_PTR = ptr(OUT); … OUT.buffer`. Reading `.buffer` on a small JavaScriptCore typed array
   relocates its storage, so the pointer before and after differed (`5357568131376` vs
   `5357551028416`). Rust then wrote into the stale block: memory corruption that surfaced only
   after ~1000 calls (a later `add(1, 1)` read wrong; a record decode saw an empty string). Fixed
   with `const b = new ArrayBuffer(16); OUT = new BigUint64Array(b); OUT_PTR = ptr(b)`.
2. **Read (ptr, len) as two `u32` halves** (`U32[0] + U32[1] * 2**32`), not `Number(OUT[0])`: the
   `BigInt` read allocates per call; switching cut `greet(short)` from ~400 to ~260–330 ns.

`bun:ffi` facts **[measured]**: `process.getBuiltinModule('bun:ffi')` works on 1.4.2;
`FFIType.usize` exists; `ptr(new Uint8Array(0))` throws ("A pointer to empty memory doesn't work"),
and an empty typed array passed directly as a `ptr` argument was read here as arriving as NULL.
**Corrected later (FFI-2, Bun 1.4.2, macOS arm64): it arrives non-null**; only JavaScript `null`
and `0` arrive as NULL. So the generated wrapper passes `null` for every zero-length argument, and
Rust must never call `slice::from_raw_parts` on the pointer of a zero-length argument, NULL or not; `new CString(ptr, 0, len)` honours `len` across embedded
NULs; a JS number passed to an `i32` argument is **silently truncated** (no range check).

## A. Results

### Correctness — 30/30 [measured]

`greet` with ASCII, empty, unicode + emoji + ZWJ, an embedded NUL, 1 MiB; a lone surrogate becomes
U+FFFD (TextEncoder's documented behaviour); `greet_ref(&str)` incl. empty; `add` incl. negative and
`i32` wrap; `sum` incl. empty `Uint8Array(0)` and a `subarray` view with a byte offset; `big(i64)`
above 2^53 and negative; `echo_bytes` incl. empty; `flag(bool)`; `parse` Ok; `parse` Err →
`RustError` with the Rust message; `boom` → `RustPanic("boom from rust")`; the next call after a
panic works; **1000 panics in a row, process alive**; `mid(Point)` with a `u64` of 2^53 + 1 and
`u64::MAX` round-trips exactly; a negative `bigint` for a `u64` field → `RustError`; a NaN `f64`
record field → `RustError` (JSON has no NaN; serde rejects the `null`).

### `panic = "abort"` guard [measured]

`CARGO_PROFILE_RELEASE_PANIC=abort cargo build --release` fails with the `compile_error!` text.
Rust's default panic hook still prints `thread '<unnamed>' panicked at demo/src/lib.rs:38:5: boom
from rust` to stderr per panic (ADR-0069 keeps it: it is the only place the source location shows).

### Leaks [measured]

RSS after a 1e4-call warm-up and `Bun.gc(true)` ×2:

| Phase (1e6 calls) | RSS before → after (MB) | Delta |
|---|---|---|
| `greet(short)` | 22.2 → 40.7 | +18.5 (first-phase JIT/heap warm-up) |
| `greet(1 KiB arg, ~1 KiB return)` | 43.8 → 47.3 | +3.5 |
| `sum(64 B)` | 47.4 → 50.3 | +3.0 |
| `mid(Point, Point)` | 51.3 → 52.5 | +1.3 |
| `greet(1 KiB)` again | 53.0 → 43.3 | −9.7 |
| **Leaking control:** raw `greet(1 KiB)` without the free, **1e5** calls | 56.4 → 187.1 | **+130.7** |

Flat after warm-up across 5e6 calls (a 1 KiB-per-call leak would be ~1 GB); the control proves the
check can see a leak (~1.3 KB per call including allocator overhead).

### Per-call overhead [measured] (best of 3 × 1e6, ns per call)

| Call | ns |
|---|---|
| `raw_noop` (plain `extern "C"`, the `bun:ffi` floor) | 1.6–3.1 |
| `raw_add` (plain `extern "C"`) | 3.5–3.8 |
| `__knext_ffi_add` called directly (shim + `catch_unwind` + out slot) | 4.8–5.2 |
| **`add` generated wrapper** | **10–11** |
| `raw_sum(64 B)` (plain, `u64` return) | 21–35 |
| `__knext_ffi_sum(64 B)` direct | 41–108 |
| **`sum(64 B)` generated wrapper** (`Vec<u8>` argument copies) | **118–126** |
| `greet(short)` raw: pre-encoded argument + call + free, no decode | 307–323 |
| **`greet(short)` generated wrapper** | **330–460** |
| **`greet(1 KiB)` generated wrapper** | **844–1960** |
| `TextEncoder.encode(1 KiB)` alone | 266–638 |
| string decode for `greet(short)`: `CString` / `toBuffer().toString` / `TextDecoder` | 300–515 / 396–1022 / 738–1211 |
| **`mid(Point, Point)` generated wrapper (JSON)** | **949–3245** |
| of which JavaScript JSON (2× stringify + encode, 1× parse) | 638–1054 |

Reading **[inferred]**: scalar calls cost ~10 ns; string calls ~0.3–1 µs, dominated by UTF-8
encode/decode and the Rust allocation; records ~1–3 µs, dominated by JSON. `&str`/`&[u8]` arguments
avoid the copy an owned `String`/`Vec<u8>` costs. Not measured: a (ptr, len, cap) return that would
skip `into_boxed_slice`'s shrink-realloc. For comparison, the 2026-10-13 note measured N-API on Bun
at 77 ns for `add` and a zone function at ~5–8 ms warm / ~1.4 s cold.

### Load cost [measured]

- `process.getBuiltinModule('bun:ffi')`: 0.25–0.7 ms (7 ms in the very first process).
- `dlopen` with 11 symbols: 1.4–4.6 ms warm (per-symbol trampoline JIT is the likely cause;
  scaling with symbol count is inferred, not measured).
- **First `dlopen` of a freshly copied, unsigned dylib on macOS: 74–94 ms** (code-signature check;
  macOS development only; Linux not measured).
- sha256 integrity check (`Bun.CryptoHasher` + `readFileSync`): 352 KB library 0.24 ms median;
  10 MiB file 5.7–9.1 ms.
- First wrapper call in the compiled executable, including the integrity hash and `dlopen`, warm:
  ~1.9 ms.

### Compiled executable, library beside it [measured]

`bun build --compile js/entry.ts` (62 MB executable). Library staged at `dist/native/libdemo.dylib`
with `dist/native/.integrity.json` (`{"version":1,"files":{"libdemo.dylib":"<sha256>"}}`), working
directory elsewhere:

1. `TMPDIR` a `chmod 555` directory, integrity required: **pass** — greet, add, sum, a caught panic,
   the call after it, and `mid` all correct; **0 files written to `TMPDIR`**.
2. Tampered hash: exit 1, `knext ffi: refusing to load libdemo.dylib: sha256 mismatch / expected … /
   actual …`.
3. Manifest absent: refused when required (`no integrity manifest at <exe dir>/native/.integrity.json`);
   the spike's not-required mode warned and loaded (ADR-0069 makes absence fatal in production).
4. Library missing: exit 1. **Gotcha:** the spike loader fell through from the executable's
   directory to `cwd/native` and named only the last path; ADR-0069 D13 requires listing every
   path tried.

### Workers [measured]

Main thread + 4 Workers, each importing the wrapper (its own module instance, `dlopen` and out
slot), 2e5 concurrent `greet` calls each: all correct.

### Cross-target build and manifest scan [measured]

- `rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl` worked.
- **A musl `cdylib` needs `-C target-feature=-crt-static`.** With default flags rustc refuses:
  `cannot produce cdylib … as the target x86_64-unknown-linux-musl does not support these crate
  types` (re-confirmed on a minimal crate).
- With `-crt-static` it links `-lgcc_s -lc` dynamically, so it needs a musl sysroot to link against
  (`rust-lld: unable to find library -lc` on macOS without one), and the runtime image needs
  `libgcc_s.so.1` (knext's Alpine stages already `apk add libstdc++ libgcc`).
- Link-only proof on macOS with empty stub `libc.a`/`libgcc_s.a` + `rust-lld` (not loadable):
  x86_64 and aarch64 musl `.so` built with LTO + strip; **all 11 `KNEXTFFI1` records present**; the
  shim functions, the free function and the 11 manifest statics are in `.dynsym`; the generator
  scanned the ELF and emitted a wrapper **byte-identical** (header comment aside) to the one from
  the macOS library. Scanning a ~350 KB library: ~10 ms.

### `cargo zigbuild` [measured]

- zig 0.17.0 (`pip install ziglang` in a scratchpad venv) and `cargo-zigbuild` (`cargo install
  --root <scratchpad>/tools`); nothing installed globally; the network allowed both.
- `RUSTFLAGS="-C target-feature=-crt-static" cargo zigbuild --release --target
  {x86_64,aarch64}-unknown-linux-musl -p demo` **links on macOS for both targets** (20 s / 32 s
  wall including dependencies; one harmless `ignoring deprecated linker optimization setting "1"`).
- ELF dynamic section (`objdump -p`): **`NEEDED libc.so` only**, no SONAME, no RPATH. **No
  `libgcc_s`**: zig links LLVM's libunwind statically (libunwind strings, `.eh_frame`,
  `.eh_frame_hdr` and `.gcc_except_table` present; no `_Unwind_*` symbol undefined or exported). So
  this artifact does not need Alpine's `libgcc`, unlike the plain `rust-lld` path above.
- `NEEDED libc.so` should resolve on Alpine because musl's loader treats `libc.so` as a reserved
  name for itself **[inferred, not loaded]**.
- Both `.so` files carry all 11 `KNEXTFFI1` records and 22 defined `__knext_ffi_*`/`__KNEXT_FFI_*`
  dynamic symbols; the generator scan (9–19 ms) emitted a wrapper identical to the macOS one.
- Not run: loading these files in `oven/bun:1.4.2-alpine` (amd64/arm64), and a panic unwinding
  through zig's libunwind on musl (only a real load exercises it) → FFI-4 (#2346).

## B. Next.js Server Action on Bun [measured]

Hand-written `cdylib` (`__knext_ffi_greet(ptr, len, out) -> i32` returning a `Box<[u8]>`, plus
free, body in `catch_unwind`); App Router app, `output: 'standalone'`; `lib/greet.ffi.ts` with
`import 'server-only'`; `app/actions.ts` (`'use server'`); a page with a form.

### Import form decides whether `next build` works

| Form | Turbopack, build under Node | webpack, build under Node | Build under `bun --bun` | Runs on Bun | On Node at runtime |
|---|---|---|---|---|---|
| (a) static `import … from 'bun:ffi'` | **fails** at "Collecting page data": `Failed to load external module bun:ffi: Error: Cannot find module 'bun:ffi'` | **fails**, same phase: `Cannot find module 'bun:ffi'` | builds | yes | **every route importing it returns 500** |
| (b) `process.getBuiltinModule('bun:ffi')`, on first call | builds | builds | not needed | yes | page renders 200; only the call fails, with the wrapper's own message |
| (c) `await import(/* webpackIgnore */ /* turbopackIgnore */ 'bun:ffi')` | builds | builds | not needed | yes | the call fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`; forces every wrapper async |
| (d) (a) + `serverExternalPackages: ['bun:ffi']` | **fails**, identical to (a) | — | — | — | — |

Both bundlers **already externalise `bun:ffi`** with no config (Turbopack emits
`a.x("bun:ffi", () => require("bun:ffi"))`, webpack `require("bun:ffi")`), so (d) changes nothing.
The failure is build-time module **evaluation** during page-data collection (page → actions →
wrapper), not bundling. ⇒ ADR-0069 D13 picks (b): bundler-agnostic, build-runtime-agnostic,
synchronous. Types come from a type-only `typeof import('bun:ffi')`, erased at build.

### The action call

`POST /` with `Next-Action: <id from .next/server/server-reference-manifest.json>`,
`Content-Type: text/plain;charset=UTF-8`, body `["World"]` → `200`,
`0:{"a":"$@1",…}\n1:"Hello, World!"\n` — identical across all six passing builds (a/b/c ×
Turbopack/webpack), server `bun .next/standalone/server.js`.

### Tracing and `server-only`

- Neither tracer copies the Rust library into `.next/standalone` (its path is resolved at run time),
  so the build must stage it. The standalone `server.js` changes directory to its own folder.
- A `'use client'` component importing the wrapper **fails the build** on both bundlers ("You're
  importing a module that depends on "server-only"").

### vinext (time-boxed; `vinext build` + `vinext start`, not knext's nitro + `--compile` pipeline)

`vinext build` with form (a) builds and keeps `bun:ffi` as an external ESM import; `vinext start`
on Bun answers the action with `{"ok":true,"data":"Hello, World!"}`; on Node every route 500s
(`ERR_UNSUPPORTED_ESM_URL_SCHEME`). Forms (b)/(c) on vinext and knext's real vinext pipeline were
not run; (b) has no import for a bundler to handle **[inferred]**.

### The generated wrapper from a Server Action — the #2315 exit criterion [measured]

- Part A's generated wrapper copied **byte-identical** into the app; a `'use server'` action calls
  the generated `greet` (Rust `String` → TS `string`) and `parse` (`Result<String, String>`), plus a
  1e5-iteration loop action.
- `next build` with **Turbopack under Node**: exit 0 (the lazy `getBuiltinModule` keeps the Node
  build safe). The library and `.integrity.json` were staged in `.next/standalone/native/`; the
  server ran as `bun .next/standalone/server.js` with integrity **required**, and it verified.
- `POST /` with the `Next-Action` header, body `["World","x"]` → `200`:
  `{"greet":"Hello, World!","ok":"parsed:42","err":{"name":"RustError","fn":"parse","message":"cannot parse \"x\": invalid digit found in string","isRustError":true}}`.
  The `Err` path is a thrown `RustError` (`instanceof` true) that the action catches.
- RSS of the server process (MiB, sampled after `Bun.gc(true)`): one invocation of 1e5 iterations
  (2e5 FFI calls) went `73.8 → 106.9 (at 20k, warm-up) → 109.0 → 109.6 → 109.6 → 109.6`. Over 12
  invocations (2.4e6 calls) it peaked at 125.8 and ended at 115.9. A control with the same
  JavaScript work and **no FFI** followed the same envelope (`73.6 → 128.7`), so none of the growth
  is attributable to FFI.
- **One wrapper change, type-checking only:** with `new Bun.CryptoHasher('sha256')` in the integrity
  check, `next build` failed with `TS2868: Cannot find name 'Bun'` in an app whose tsconfig lists
  only Node types. `createHash('sha256')` from `node:crypto` (implemented by Bun) fixed it and still
  verified on Bun. ⇒ ADR-0069 D13: the generated module type-checks without `@types/bun`.
- Not run: a tampered manifest through the server (the code path exists; exercised only in part A's
  compiled-executable test).
- **Which load path this exercised:** the server was `bun server.js`, not a compiled executable,
  so `process.execPath` was Bun's install directory and the library was found through the spike
  loader's `cwd/native` fallback (the standalone `server.js` changes directory to its own folder).
  This run supports the generated wrapper inside Next, not ADR-0069 D13's path 1
  (`dirname(process.execPath)/native`); path 1 is what part A's compiled-executable run supports.

## Not run (handed to the implementation tickets)

- Loading the musl `.so` in `oven/bun:1.4.2-alpine` on amd64 and arm64, with a read-only root file
  system: local Docker is out of disk and nothing was pruned → ADR-0069 FFI-4 (#2346).
- glibc builds (out of v1 scope); `readOnlyRootFilesystem` on a real cluster → FFI-4.
- Enums (only struct records were exercised); data-carrying enums are a compile error in v1.
- knext's own `knext build` path end to end (it does not exist yet) → FFI-3 (#2345), FFI-4.
- The ADR's signature-hashed symbol names (added after the spike; a naming change only).
