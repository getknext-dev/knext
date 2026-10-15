# ADR-0069: In-process Rust for Bun zones via `bun:ffi`, with a generated typed `server-only` wrapper (Beta)

- **Status:** **Accepted (2026-10-15)** at the v2 Sprint 4 close design review (#2386). The lead's
  tiebreak between the two gates chose Accepted over keeping it Proposed (jev **0.99**, re-scored 2026-10-15). Acceptance is
  the *decision* status only: the feature's *product stage* stays **Beta**, as D2 states, and leaves
  Beta only on D19's graduation trigger. Acceptance does not generalise D2's exception to "Node is
  always an option"; ADR-0064 preserved constraint 11 now points back here and bounds it.
  History: **Proposed (2026-10-14).** Founder-directed on #2315 (comments of 2026-10-14):
  `bun:ffi`, Bun-only, a generator that writes a typed `server-only` TypeScript wrapper per exported
  Rust function, shipped opt-in and **Beta until Bun drops the experimental label on `bun:ffi`**, and
  built in the current sprint (v2 Sprint 4). The implementation tickets in *Action items* may start
  when this ADR merges; under the 2026-09-22 workflow amendment the design gates review it at sprint
  close, not as a merge gate.
- **Trigger classes:** ADR; public CLI surface (`knext ffi …`); supply chain (a native library in the
  image); the core-vs-app boundary; and a **scoped exception to "Node is always an option"**
  (the founder rule of 2026-10-02, restated as ADR-0064's preserved constraint 11), which the
  founder made for this feature only.
- **Depends on:** ADR-0002/0003/0004 and ADR-0052 (zone functions, the positioning this sits beside),
  ADR-0048 Amendment 3 (the `native/` + integrity pattern), ADR-0060 (invariant I2, execPath
  anchoring), ADR-0058 (the build × runtime cells).
- **Supersedes:** the napi-rs, Node + Bun recommendation of the 2026-10-13 research for #2315
  (a local note, `.claude/research/native-rust-on-bun-2026-10-13.md` §7, summarised in the issue's
  first comment). Its measurements stand; its recommendation was overruled by the founder.
- **Evidence for this ADR:** `docs/benchmarks/bun-ffi-spike-2026-10-14.md` (the spike, measured on
  Bun 1.4.2, macOS arm64). jev scores are cited per decision; they are a gut-check, not the deciding
  vote.

## Context

### What is asked

A zone (a Next.js app deployed by knext) wants to call a hot, CPU-bound Rust function (parse,
validate, hash, transform) **inside its own process**, typed end to end, without the network hop and
the cold start of a zone function. The founder fixed the mechanism (Bun's `bun:ffi`), the runtime
(Bun only), the developer experience (a generator writes a typed wrapper; a Rust `String` return
becomes a TS `string`) and the label (Beta until `bun:ffi` is stable upstream).

### Facts this ADR is written against

1. **`bun:ffi` is experimental upstream.** Bun's docs, verbatim, in the `bun-types@1.4.2` package
   knext pins (`docs/runtime/ffi.mdx`): "`bun:ffi` is **experimental**, with known bugs and
   limitations. Do not rely on it in production." That sentence is the graduation trigger (D19).
2. **`bun:ffi` is Bun-only.** Node has no `bun:ffi`; `node:ffi` exists only from Node 26.1, also
   experimental. knext's Node cells cannot run this feature.
3. **knext's cells (ADR-0058).** `build ∈ {turbopack (default), webpack, vinext}` ×
   `runtime ∈ {bun (default), node}`. Every Bun cell ships a **compiled Bun executable**:
   - `vinext × bun`: `/app/server`, `native/` already beside it (`COPY native /app/native`).
   - `turbopack|webpack × bun`, disk mode: `/app/.next/standalone/knext-standalone-exec`.
   - `turbopack|webpack × bun`, self-contained: `/app/knext-standalone-exec`.

   `process.execPath` is the real on-disk path even inside a compiled binary (verified for sharp).
   ADR-0060's invariant **I2** says anything not embedded resolves from `dirname(process.execPath)`.
4. **Embedding a native library in a compiled Bun executable needs a writable temp directory.** Bun
   extracts it to `$TMPDIR`/`BUN_TMPDIR` on load; with a read-only `TMPDIR` the load fails silently
   with a misleading `/$bunfs/… no such file` error (measured; filed as oven-sh/bun#45166). Loading
   a library **beside** the executable by absolute path needs no extraction and works with a
   read-only file system (measured in the #2315 research and again in this spike).
5. **The `native/` + integrity pattern exists.** `knext build` writes `native/.integrity.json` (a
   sha256 per file under `native/`, `native-integrity.ts`), and the sharp shim re-checks it before
   `process.dlopen` (`sharp-addon-dlopen.mjs`). The writer walks the whole tree, so a file staged
   under `native/` before the writer runs is hashed with no change to the writer.
6. **knext images are Alpine (musl)**; the shipped arch keys are `linux-x64` and `linux-arm64`
   (`vinext-build.ts` `COMPILE_TARGETS`). A musl `cdylib` must be built with
   `-C target-feature=-crt-static`: with default flags rustc 1.97.1 refuses outright (`cannot
   produce cdylib … as the target x86_64-unknown-linux-musl does not support these crate types`,
   measured). The dynamic build then needs a musl sysroot to link against (`rust-lld: unable to
   find library -lc` on macOS without one). Through `cargo zigbuild` it links on macOS for both
   x86_64 and aarch64, and the library's only `DT_NEEDED` entry is `libc.so`: zig links LLVM's
   libunwind statically, so no `libgcc_s` is needed (measured; a plain `rust-lld` link against an
   Alpine sysroot would add `-lgcc_s` instead). Whether musl's loader resolves `NEEDED libc.so` to
   itself on Alpine, and whether a panic unwinds through zig's libunwind there, is inferred, not
   measured: that is the first thing FFI-4 proves.
7. **Zone functions exist** (ADR-0002/0003/0004/0052): out-of-process Go or Rust services over
   Connect, scale-to-zero, ~5–8 ms per warm call and ~1.4 s when cold (kind, emulated). They are the
   right tool for I/O, business logic, independent scaling and crash isolation. This ADR does not
   replace them.
8. **`knext generate` is taken**: core routes it to the optional `@getknext/grpc` package
   (`grpc-dispatch.ts`, ADR-0052 D8), which keeps its settings in `knext.grpc.json`, not in
   `knext.config.ts`.

### What the spike measured

See `docs/benchmarks/bun-ffi-spike-2026-10-14.md` for commands and raw numbers. Summary:

Bun 1.4.2, rustc 1.97.1, Next 16.3.8, macOS arm64 (M1 Pro), on a machine shared with other agents,
so nanosecond figures vary up to about 2x between runs. A real `#[export]`/`#[record]` proc macro,
a `cdylib` carrying its own manifest, a generator that scans the library, and the generated wrapper.

| Question | Result |
|---|---|
| Correctness | 30/30: unicode, emoji, embedded NUL, empty string and empty `Uint8Array`, 1 MiB strings, `i64` above 2^53, `u64::MAX` inside a record, `Err` → `RustError`, panic → `RustPanicError` |
| Panic safety | 1000 panics in a row, process alive, next call correct; `panic = "abort"` is a compile error |
| Leaks | RSS flat after warm-up over 5e6 calls (`String`, 64 B `Vec<u8>`, a JSON record); a control that skips the free grows 130.7 MB per 1e5 calls, so the check can see a leak |
| Per-call cost (ns) | raw `bun:ffi` 1.6–3.8; shim + `catch_unwind` ~5; generated `add(i32, i32)` ~10; `sum(Vec<u8> 64 B)` 118–126; `greet(short String)` 330–460; `greet(1 KiB)` 840–1960; `mid(record, record)` 950–3245 (0.6–1 µs of it JSON) |
| Load cost | `getBuiltinModule('bun:ffi')` 0.25–0.7 ms; `dlopen` (11 symbols) 1.4–4.6 ms; sha256 of a 352 KB library 0.24 ms; first call in a compiled executable including integrity and `dlopen` ~1.9 ms |
| Compiled executable | library in `native/` beside a `bun build --compile` binary, `TMPDIR` read-only: every call correct, nothing written to `TMPDIR`; tampered hash, absent manifest (when required) and missing library each refused with a clear message |
| Workers | main thread + 4 Workers, 2e5 concurrent calls each, all correct (one module instance, `dlopen` and out slot per Worker) |
| Manifest | records survive `lto = true` + `strip = true`; a link-only musl x86_64/aarch64 build carries all of them, and the generator emits the same wrapper from the ELF as from the macOS library |
| Next.js | a Server Action on Bun calls Rust through `bun:ffi` and returns `"Hello, World!"` on Turbopack and webpack; the import form decides whether `next build` works (D13). The **generated** wrapper, built by Turbopack under Node and served by `bun .next/standalone/server.js` with integrity required, returned the Rust `String` and surfaced `Err` as a catchable `RustError`; RSS held flat over 2.4e6 calls (same envelope as a no-FFI control). That server was `bun server.js`, not a compiled executable, so `process.execPath` was Bun's install directory and the library resolved through the spike loader's `cwd/native` fallback (the standalone `server.js` changes directory to its own folder). This run supports the **generated wrapper** (types, marshalling, errors, leaks) inside Next; it does **not** exercise D13's path 1. Path 1 (`dirname(process.execPath)/native`, integrity required, read-only `TMPDIR`) is supported by the compiled-executable run (row above, spike Part A) |
| Linux build | `cargo zigbuild` links the musl `.so` for x86_64 and aarch64 on macOS; `DT_NEEDED` is `libc.so` only; all manifest records present; same generated wrapper |
| Not run | the musl `.so` on `oven/bun:1.4.2-alpine` (amd64/arm64), glibc, `readOnlyRootFilesystem` on a cluster: local Docker is out of disk. These are FFI-4's job (#2346) |

Two generator rules came out of the spike and are binding (D13): take `ptr()` of an explicit
`ArrayBuffer`, never of a small typed array whose `.buffer` is read later (JavaScriptCore moved the
storage, and Rust wrote into freed memory after about 1000 calls); and read returned pointer/length
pairs as two `u32` halves, not through a `BigInt` (which allocates on every call).

## Decision

### D1. Mechanism and positioning: `bun:ffi` beside zone functions, never instead of them (jev: bun:ffi **1.00**, napi-rs 0.00, WASM 0.00, zone functions only 0.00)

A zone may ship **one** Rust `cdylib` whose exported functions it calls in-process through
`bun:ffi`. (The jev score reads the founder's constraints literally; it confirms fit, it did not
choose.) Use which:

| | In-process Rust (this ADR) | Zone function (ADR-0002/0004) |
|---|---|---|
| Call cost | nanoseconds to microseconds (spike) | ~5–8 ms warm, ~1.4 s cold |
| Cold start | none beyond the zone's own; library loaded on first call | its own scale-from-zero |
| Scaling | scales with the zone | independent, scales to zero on its own |
| Crash radius | the whole zone pod (an abort, segfault or stack overflow) | the function pod only |
| Blocking | blocks the zone's event loop for the call's duration | never blocks the zone |
| Languages | Rust only | Go, Rust (any Connect server) |
| Runtime | **Bun only** | Node and Bun |
| Security boundary | none (same process) | per-call token, cluster-local only |
| Use for | hot, CPU-bound, stateless, sub-millisecond work | I/O, business logic, anything that should scale, fail or deploy on its own |

### D2. Scope, the Node exception, and the Beta label

- **Bun only.** The founder made this a scoped exception to "Node is always an option" (ADR-0064,
  preserved constraint 11): the framework still supports Node; an app that opts into this feature
  cannot use the Node runtime. D15 says how the refusal works.
- **Opt-in.** An app without `knext.ffi.json` gets byte-identical build output and images (D17).
- **Beta**, labelled everywhere a user meets it: the CLI help group and every `knext ffi` run, the
  header of every generated file, the docs page, and `docs/PUBLIC_API.md`'s experimental surfaces.
  Not covered by the compatibility credential.
- **Not in v1:** Node, Edge runtime and middleware, callbacks from Rust into JavaScript, async
  functions, more than one library per zone, the self-contained single-executable mode (D14),
  glibc images, Windows and macOS **images** (macOS is supported for development only).

### D3. Rust side: two crates in this repo, consumed by git revision (jev: in-repo crates + git dependency **0.93**, path-only 0.06, vendored 0.01, separate repo 0.00; pin by full rev **1.00**, tag 0.00, branch 0.00)

- `crates/knext-ffi` — the runtime half: the ABI types, `knext_ffi_v1_free`, the panic and error
  plumbing, the JSON helpers (including 64-bit-as-string), and a re-export of the macros.
- `crates/knext-ffi-macros` — the proc-macro half: `#[knext_ffi::export]` on a `pub fn`, and
  `#[knext_ffi::record]` on a struct or a unit enum.
- `crates/Cargo.toml` is a Cargo workspace for those two only (not the repository root, so no tool
  mistakes the monorepo for a Rust project). Toolchain pinned by `crates/rust-toolchain.toml`.
- **Consumption before crates.io:** a zone's `rust/Cargo.toml` depends on
  `knext-ffi = { git = "https://github.com/getknext-dev/knext", rev = "<40-hex>" }`. The rev is the
  commit the installed `@getknext/ffi` release records, written by `knext ffi init`, so the macro and
  the generator always agree on ABI version 1. A rev, not a tag: knext pins Actions by full SHA for
  the same reason (a tag is a movable ref). Inside this monorepo (fixtures, the kind e2e) a path
  dependency is used. **crates.io publication is a founder action** and changes only that one line.

### D4. The ABI, version 1 (exact; the macro and the generator are written against this)

(jev: signature-hashed symbol names **1.00**, plain names 0.00; `catch_unwind` in every shim
**0.80**, let panics abort 0.20; keep Rust's default panic hook **0.82**, silence it 0.18.) The spike
ran this ABI unchanged; only the symbol naming below was added afterwards.

**Symbols.** Every name the wrapper binds starts with `knext_ffi_v1_`, so a library of another ABI
version fails `dlopen` by name instead of being called wrongly.

- One shim per export: `knext_ffi_v1_<fn>_<h>`, where `<h>` is 8 lowercase hex digits of FNV-1a
  (32-bit) over the export's canonical signature string (the manifest's `sig`, D5). The macro
  computes it; the generator copies it from the manifest and never recomputes it. **Why:** calling a
  C function with the wrong argument layout is undefined behaviour that can corrupt the zone's heap.
  With the signature in the name, a wrapper generated before a signature change fails `dlopen` with
  a missing symbol, which the loader reports as a stale wrapper (`FfiLoadError`, "run `knext ffi
  generate`"). That covers `next dev`, where the build-time drift check (D14) does not run.
- **The signature hash covers the transitive record and enum schemas the function names**, not only
  its own argument and return types: a record field that names another record, an
  `Option<Record>`, a `Vec<Enum>`, at any depth. Adding, removing, renaming, reordering or retyping
  a field or a variant anywhere the function can reach is a stale wrapper. (A JSON shape change is
  not memory-unsafe, but serde would silently fill or drop fields: a wrong answer, not an error.)
  The canonical schema string is the function's `sig` followed by each reachable record as
  `Name{field:type,…}` (declaration order) and each enum as `Name[Variant|…]`, sorted by name.
  A proc macro on a function cannot read another item's definition at expansion time, and a
  symbol name must be a literal, so the check has two halves that together are "the signature
  hash":
  - `<h>` in the shim's name hashes `sig` (what the export macro sees);
  - the export macro emits `knext_ffi_v1_<fn>_<h>_schema() -> u64`, which returns the FNV-1a
    (64-bit: offset `0xcbf29ce484222325`, prime `0x100000001b3`) of the **full canonical schema
    string**: `sig`, then every record and enum reachable from it (transitive closure,
    de-duplicated by name, sorted by name byte-wise), concatenated with **no separator**. Records
    contribute their canonical form through a hidden `KnextSchema` trait (`#[knext_ffi::record]`
    implements it) so the string is assembled at compile time; the value is a hash of that one
    string, **not** a hash of per-type hashes. This is the only definition (round 3; jev 0.93 for
    keeping the flat string FFI-1 already implements over a Merkle hash-of-hashes). The generator builds the same string from the
    manifest's `fn`, `record` and `enum` records (it already resolves every name a function uses,
    D5) and writes the expected value into the wrapper; the loader calls every `_schema` symbol
    once, right after `dlopen`, and turns any mismatch into the same stale-wrapper `FfiLoadError`.
    One call per export, at load only.
  The macro crate's tests change one nested field two records deep and assert the `_schema` value
  changes; a golden test pins that the Rust `const fn` and the generator's TypeScript hash agree on
  the same canonical string.
- `knext_ffi_v1_free(ptr: *mut u8, len: usize)`, defined once in `knext-ffi`.

**Shim signature.**

```rust
#[no_mangle]
pub extern "C" fn knext_ffi_v1_<fn>_<h>(/* lowered args */, out: *mut [u64; 2]) -> i32
```

**Arguments**, lowered left to right:

- integers, floats, `bool`: one argument of the same C type (64-bit ones are `bigint` on the
  JavaScript side; v1 targets are 64-bit only, so `usize`/`isize` are 64-bit);
- `String`, `&str`, `Vec<u8>`, `&[u8]` and every JSON type (D7): two arguments, `(ptr: *const u8,
  len: usize)`, UTF-8 for strings and JSON. **When `len == 0` the shim never reads `ptr`**, NULL
  or not: it builds an empty slice without calling `slice::from_raw_parts`, which on NULL would be
  undefined behaviour. (Correction, measured during FFI-2 on Bun 1.4.2, macOS arm64: an empty
  `Uint8Array` passed directly as a `ptr` argument arrives **non-null**; only JavaScript `null` and
  `0` arrive as NULL. The spike's "an empty typed array arrives as NULL" was wrong. `ptr()` of an
  empty array still throws. So the generated wrapper passes `null` for **every** zero-length
  `(ptr, len)` argument, and the shim's `len == 0` rule does not depend on what Bun sends.)

**Status** (the `i32` return): `0` OK, `1` `Err` from a `Result`, `2` panic, `3` invalid input (bad
UTF-8 or JSON the shim could not decode) **or a JSON return value that cannot be encoded** (a
non-finite float anywhere inside it; the message names the path, e.g. `result.samples[2]`). Any
other value is a wrapper bug and is reported as one. (Amendment: status 3 now covers both
directions. The wrapper still prefixes every status-3 message with `invalid input:`, so the
return-side case reads `invalid input: knext-ffi: the return value cannot cross as JSON: …`; the
prefix was kept rather than adding a status or splitting it, to leave ABI v1 unchanged, and the
generated TSDoc and the user docs say plainly that this one is an output fault.)

**The out slot** is 16 bytes, 8-byte aligned, owned by the caller, written by the shim:

- status 0, scalar return: the value at offset 0, little-endian, native width (`write_unaligned`);
- status 0, `String`/`Vec<u8>`/JSON return: `out[0]` = pointer, `out[1]` = length of a Rust
  `Box<[u8]>`; `(0, 0)` for an empty value, which allocates nothing and is not freed;
- status 1, 2 or 3: the UTF-8 message as a `(pointer, length)` buffer, freed the same way;
- `()` return: nothing written.

**Panics.** Every body runs inside `std::panic::catch_unwind`; nothing unwinds across the boundary
(since Rust 1.81 that would abort the process). `knext-ffi` contains
`#[cfg(panic = "abort")] compile_error!(…)`, so a crate built with `panic = "abort"` does not
compile (verified in the spike). Rust's default panic hook stays: it writes `thread … panicked at
<file>:<line>` to the pod's stderr, which is the only place the source location appears; the
message also becomes the `RustPanicError`. An abort, segfault, stack overflow or `std::process::exit`
in Rust or in anything it calls still ends the process; the docs say so.

**Ownership guarantees the macro provides:** no pointer to an argument outlives the call, and every
non-empty buffer handed to JavaScript is freed exactly once, by the wrapper (D9). All v1 targets are
little-endian.

### D5. The manifest is embedded in the library (jev: embedded records **1.00**, proc-macro side file 0.00, build.rs source parse 0.00, manifest() via dlopen 0.00)

For each `#[knext_ffi::export]` function and each `#[knext_ffi::record]` type, the macro emits an
exported static (`#[no_mangle] pub static __KNEXT_FFI_MANIFEST_<symbol>: [u8; N]`) holding the
9-byte magic `KNEXTFFI1`, one JSON object, and a NUL. The spike verified the records survive
`lto = true`, `strip = true`, `codegen-units = 1` and `opt-level = 3`, and appear in a
cross-compiled musl ELF.

Record shapes (v1):

```json
{"v":1,"kind":"fn","name":"greet","symbol":"knext_ffi_v1_greet_1a2b3c4d",
 "sig":"greet(string)->string","doc":"Says hello.",
 "args":[{"name":"name","type":{"t":"string"},"rust":"String"}],
 "ret":{"type":{"t":"string"},"rust":"String"},"err":null}
{"v":1,"kind":"record","name":"Point","doc":"","fields":[{"name":"id","type":{"t":"u64"},"rust":"u64"}]}
{"v":1,"kind":"enum","name":"Color","doc":"","variants":["Red","Green"]}
```

A type descriptor is `{"t": <scalar>}` with `<scalar>` one of `i8 i16 i32 i64 isize u8 u16 u32 u64
usize f32 f64 bool string bytes unit`, or `{"t":"record","name":…}`, `{"t":"enum","name":…}`,
`{"t":"option","of":<descriptor>}`, `{"t":"vec","of":<descriptor>}`. `err` is `{"rust":"<E>"}` when
the return is a `Result`. `rust` fields are for messages and TSDoc only; the generator never parses
Rust.

**The generator** reads the library file's bytes (it never loads the library, so a musl `.so` built
on a macOS host can be scanned), finds every `KNEXTFFI1`, parses the JSON up to the NUL, and fails
loudly on: no records ("no exported functions found; is this the right library?"), an unknown `v`,
a JSON parse error (naming the byte offset, which also catches a false-positive magic in user
data), a duplicate export name, or a function that names a record or enum with no record of its
own. Scanning a 350 KB library took about 10 ms in the spike.

**Why embedded:** the wrapper is derived from the exact bytes that ship (D14 step 5), so the two
cannot drift in an image. A proc macro writing a side file is not supported by cargo (an
incremental build skips re-expansion, leaving files stale or missing); a `build.rs` that parses the
source sees neither macro expansion nor `cfg`; and a `manifest()` function read through `dlopen`
cannot be called on a cross-compiled library. Two crates in one library that export the same name
and signature fail at link time, loudly.

### D6. Type mapping (v1)

| Rust (argument or return) | TypeScript | How it crosses |
|---|---|---|
| `i8` `i16` `i32` `u8` `u16` `u32` | `number` | by value |
| `i64` `u64` `isize` `usize` | `bigint` (jev: always bigint **0.54**, `i64_fast` number-or-bigint 0.45, number with range check 0.01; low confidence 0.31, decided on the static-type argument) | by value |
| `f32` `f64` | `number` | by value |
| `bool` | `boolean` | by value |
| `String`, `&str` | `string` | in: UTF-8 bytes (ptr, len), borrowed for the call; out: Rust-owned bytes, copied and freed (D9) |
| `Vec<u8>`, `&[u8]` | `Uint8Array` | in: (ptr, len), borrowed; out: copied into a fresh `Uint8Array`, then freed |
| `()` (return) | `void` | — |
| `#[knext_ffi::record] struct` | a generated `interface` | JSON (D7) |
| `#[knext_ffi::record] enum` (unit variants only) | a string-literal union | JSON (D7) |
| `Option<T>` (`T` not itself an `Option`), `Vec<T>` (`T` ≠ `u8`) | `T \| null`, `T[]` | JSON (D7) |
| `Result<T, E>` (return only), `E: Display` | `T`; `Err` throws `RustError` | D8 |

Anything else (references other than `&str`/`&[u8]`, lifetimes on returns, generics, `impl Trait`,
tuples, `char`, `i128`, raw pointers, `async fn`, methods, and a nested `Option<Option<T>>` in any
position: argument, return, record field or inside a `Vec`) is a **compile error from the macro**
naming the unsupported type and pointing at this table. `Option<Option<T>>` is rejected because
`None` and `Some(None)` would both cross as JSON `null`, so the outer level would be lost
(`Option<Vec<Option<T>>>` is fine: the `Vec` separates the two levels). Arguments of a JSON type are accepted by
value only. An owned `String`/`Vec<u8>` argument costs Rust a copy that `&str`/`&[u8]` avoids, so
the docs recommend the borrowed forms.

### D7. Records and enums cross as JSON (jev: JSON **1.00**, binary codec 0.00, `repr(C)` 0.00)

- `#[knext_ffi::record]` derives serde's `Serialize`/`Deserialize` (through `knext_ffi`'s re-export,
  so the zone does not add serde itself) and embeds a schema record in the manifest (D5). The
  generator emits one TS `interface` per struct and one string-literal union per unit enum.
- Field names cross verbatim (no case conversion), so the TS interface mirrors the Rust struct.
- **Every 64-bit integer (`i64`, `u64`, `isize`, `usize`) in any JSON position travels as a decimal
  string** and is `bigint` in TypeScript (jev: string-encode every position **0.96**, compile error
  outside record fields 0.04). "Any JSON position" means all of: a top-level `Option<u64>` or
  `Vec<i64>` argument or return; a record field; an `Option`/`Vec` field inside a record
  (`Option<u64>`, `Vec<usize>`, `Vec<Option<i64>>`); and any nesting of those. The encoding is
  applied per position from the schema, not per record: the record macro applies it to fields, and
  the export macro applies the same serde adapter to top-level JSON arguments and returns, so there
  is no position where a 64-bit value crosses as a JSON number. The generated encoder and decoder
  walk the type descriptor (D5) and convert at exactly those positions (`bigint` → decimal string
  in, decimal string → `bigint` out); a TS `bigint` never meets `JSON.stringify` directly, and a
  JSON number where the schema says a 64-bit integer is refused with a `RustError` naming the
  path. Golden tests cover each position listed here, with values above 2^53 and `u64::MAX`.
- **Floats inside JSON must be finite**, in both directions and in every JSON position, `Option`
  included, because JSON has no NaN or Infinity (an `Option` would otherwise read a `null` as
  `None` and lose the value silently). JavaScript to Rust: the generated wrapper checks every float
  inside a JSON argument before the call and throws a `TypeError` naming the path
  (`argument "r.samples[1]"`). Rust to JavaScript: the wire codec refuses to serialize a non-finite
  float and the shim returns status 3 naming the path (`result.samples[2]`, D4). A JSON number that
  does not fit a finite `f32` is refused on decode (status 3). Plain top-level `f32`/`f64`
  arguments and returns are unaffected: they cross raw, NaN and Infinity included.
- A negative `bigint` for a `u64` field (or any out-of-range value) is refused the same way
  (measured).
- Inside a JSON type, a `Vec<u8>` is a JSON array of numbers and is typed `number[]`; binary data
  belongs in a top-level `Vec<u8>`/`&[u8]` argument or return, which crosses as raw bytes.
- Data-carrying enums, generics and recursive records are compile errors in v1.
- JSON was chosen over a binary codec because a second hand-written decoder per format version is
  more code and more bugs than one sprint can carry, and the per-call cost is dominated by the work
  for the intended payloads. The measured cost is in the committed spike report
  (`docs/benchmarks/bun-ffi-spike-2026-10-14.md`, "Per-call overhead"): the generated
  `mid(Point, Point)` record round trip is **949–3245 ns** per call, of which 638–1054 ns is
  JavaScript-side JSON (two stringify + encode, one parse).

### D8. Errors

Three error classes, exported from the generated module:

- `RustError` — the function returned `Err(e)`; `message` is `e.to_string()`, `fn` is the export
  name. Also thrown for invalid input the shim could not decode (status 3), with a message saying so,
  and for a JSON return value Rust could not encode (also status 3, same `invalid input:` prefix;
  the message says `the return value cannot cross as JSON` and names the path).
- `RustPanicError` — the function panicked; `message` is the panic payload (`&str`/`String`, else
  `"panic with a non-string payload"`). The process keeps running and the next call works (spike).
- `FfiLoadError` — the library could not be loaded: not Bun (D15), not found (with every path
  tried), wrong platform, integrity mismatch, or a missing symbol (a stale wrapper, D4).

All three extend `Error` and are `instanceof`-checkable; none carries Rust memory.

### D9. Memory ownership: copy, then free, synchronously (jev: copy-then-free **0.98**, zero-copy `Vec<u8>` with a native deallocator 0.02)

- **Arguments** are JavaScript memory, borrowed for the duration of the call only. The macro hands
  Rust a `&str`/`&[u8]` bounded by the call, or copies into an owned `String`/`Vec<u8>` when the
  signature asks for one. Rust never keeps a pointer to an argument.
- **Returns** that are not scalars are a Rust-allocated `Box<[u8]>`. The generated wrapper copies the
  bytes into a JavaScript value (`string`, `Uint8Array`, or parsed JSON) and calls
  `knext_ffi_v1_free(ptr, len)` in a `finally`, on success, `Err` and panic payloads alike. An empty
  value comes back as `(0, 0)`, allocates nothing, and is not freed.
- The developer never frees anything; the generator owns that. The leak check in the spike (1e6
  calls, RSS flat) is a required test in the macro crate's CI and in the kind e2e (D20).
- (A first jev run that framed zero-copy as needing an experimental `JSCallback` scored it 0.67; the
  framing was wrong — `toArrayBuffer` takes a native deallocator — and the corrected run above is
  the one cited. Zero-copy `Vec<u8>` returns stay possible later behind an attribute, once measured.)

### D10. Blocking and async (jev: synchronous v1 + Worker guidance **0.97**, Rust thread + threadsafe callback 0.02, generated async variant 0.01)

`bun:ffi` calls are synchronous: a call blocks the zone's JavaScript thread, and with it every
other request on that pod, for its whole duration.

- v1 generates **synchronous** functions only. The docs give a budget: keep a call on the request
  path under about a millisecond; run longer work in a Bun `Worker` that imports the generated
  module (each Worker loads the library once; Rust statics are shared across Workers, which Rust's
  `Sync` rules already make safe).
- No Rust-to-JavaScript callbacks (`JSCallback`, and its threadsafe mode, are separately
  experimental in Bun). A generated async variant is later work and needs its own decision.

### D11. Where it lives in a zone, and the config file (jev: `rust/` crate **0.87**, root Cargo.toml 0.13, multiple libraries 0.00; `knext.ffi.json` **0.95**, `knext.config.ts` field 0.03, Cargo metadata 0.02)

```
my-zone/
  knext.ffi.json            # opts the zone in; owned by @getknext/ffi
  rust/
    Cargo.toml              # [lib] crate-type = ["cdylib"], knext-ffi git rev (D3)
    Cargo.lock              # committed; every build is --locked
    rust-toolchain.toml     # pinned toolchain
    deny.toml               # cargo-deny policy (D16)
    src/lib.rs              # #[knext_ffi::export] functions
  src/generated/ffi/
    index.ts                # generated, committed (D13)
    .knext-generated.json   # what the generator wrote (ownership, as knext generate does)
```

`knext.ffi.json` (v1, validated by `@getknext/ffi`, unknown keys rejected):

```json
{ "version": 1, "crate": "rust", "out": "src/generated/ffi" }
```

- `crate` — the crate directory, relative to the app root, not `.`, not outside the app, not in
  `node_modules`. One library per zone; split code into internal crates with a Cargo workspace
  under `rust/` if needed.
- `out` — the generated-module directory, with the same validation `knext.grpc.json`'s `out` has.
- The build target triples are **not** configured here: they follow the image arch `knext build`
  is already building (D14), so there is one source of truth.
- Core reads **only the file's existence** (to refuse Node and to stage `native/`); it never parses
  it.

### D12. Package and CLI: `@getknext/ffi`, `knext ffi …` (jev: new optional package **0.92**, inside `@getknext/grpc` 0.08, in core 0.00; verb group `knext ffi` **0.62**, `knext generate ffi` 0.35, merged `generate` 0.03; private at Beta **0.97**)

- A new optional package **`@getknext/ffi`** (`packages/ffi`), `private: true` at Beta like
  `@getknext/grpc`; publishing it is a founder action. It holds the generator, the config schema,
  the manifest scanner, the `knext ffi build` orchestration, and the templates for `knext ffi init`.
- Core gains `packages/kn-next/src/cli/ffi-dispatch.ts`, a copy of the `grpc-dispatch.ts` protocol
  (lazy, runtime-resolved import; peer-range check; `--help` answered even when the package is
  missing; plain messages, exit codes, nothing thrown). Core does not depend on the package.
- Verbs (all under one group so `knext generate` stays the zone-functions verb):

| Verb | What it does | Needs Rust? |
|---|---|---|
| `knext ffi init` | writes `knext.ffi.json`, `rust/` (Cargo.toml with the D3 rev, Cargo.lock-free start, `src/lib.rs` with `greet`, toolchain, `deny.toml`); refuses to overwrite | no |
| `knext ffi generate` | `cargo build` for the host, scan the library (D5), write `out/` | yes |
| `knext ffi check` | the same, but compare and exit 1 on drift (CI) | yes |
| `knext ffi build --target <triple>… --native-dir <dir>` | D14: cross-build, libc check, stage, and drift-check the committed wrapper against the **shipped** library | yes |

- **Name refusals** (`generate`, `check`, and the `build` drift check, which render the same
  module). A Rust name becomes a TypeScript identifier verbatim, so the generator refuses, naming
  the clash and saying "rename it in Rust": a function or argument name that is a JavaScript
  reserved word or shadows a name the generated module itself uses (the globals it references,
  such as `process`, `JSON`, `Error`, `console`, `Record`, `TextEncoder`, and the names it declares,
  `RustError`, `RustPanicError`, `FfiLoadError`); a record or enum name that is any of those or a
  TypeScript built-in type name (`string`, `number`, `bigint`, …) or a type-operator keyword
  (`keyof`, `infer`, …); and a record field named `__proto__`. The module's own imports and
  internals are `$`-prefixed, which a Rust identifier cannot be, so they never collide. The list
  is `RESERVED`/`RESERVED_TYPES` in `packages/ffi/src/manifest.ts`, and
  `ffi-render-hygiene.test.ts` scans a rendered module for every name it declares or references so
  the list cannot fall behind the emitter. There is no rename attribute in v1
  (`#[knext_ffi::export]` takes no arguments).
- Help group heading: **"In-process Rust (Beta, Bun only, optional package)"**. Every run prints one
  line naming the Beta status and the upstream `bun:ffi` status.

### D13. The generated module (jev: committed + `check` **0.98**, gitignored 0.02; lazy load **1.00**, eager 0.00)

`<out>/index.ts` is **committed**, so `next build` and type-checking work on a fresh checkout with no
Rust toolchain, and `knext ffi check` (CI) and `knext ffi build` (image) fail on drift. Its contract:

1. Header: generated-file notice, the Beta line, the ABI version, the manifest digest it was
   generated from, and "do not edit".
2. `import 'server-only'` as the first statement. Importing it into a Client Component fails the
   build (verified for Next in the spike). Unit tests that import it outside Next run with
   `bun test --conditions=react-server`.
3. **No top-level `bun:ffi` import and no work at import time.** `bun:ffi` is obtained lazily, on
   the first call, through `process.getBuiltinModule('bun:ffi')`. The module **type-checks without
   `@types/bun`**: it declares the small slice of the `bun:ffi` API it uses as local types, and it
   hashes with `node:crypto`'s `createHash` (which Bun implements), not `Bun.CryptoHasher` — a
   generated file using the latter failed `next build` with TS2868 "Cannot find name 'Bun'" in an
   app whose tsconfig lists only Node types (measured). Measured in the spike, on Next 16.3.8 with both
   Turbopack and webpack: a static `import … from 'bun:ffi'` **fails `next build`** at "Collecting
   page data" whenever the build runs under Node (`Cannot find module 'bun:ffi'`; adding it to
   `serverExternalPackages` changes nothing, both bundlers already externalise it), and on a Node
   server it takes **every route** that imports it down with a 500. `getBuiltinModule` builds on
   both bundlers under Node and Bun, keeps calls synchronous (a dynamic `import()` would force every
   wrapper async), and on Node leaves the page rendering with only the call failing. So the module
   can be imported (not called) anywhere a server module can, and knext's post-compile smoke (which
   boots a host-arch twin of the server without an ffi library) does not need one.
4. On the first call: the Bun check (D15), path resolution, the integrity check, `dlopen` with the
   full symbol list. Any failure is an `FfiLoadError`, cached, so every later call fails the same
   way without retrying.
5. **Path resolution**, in order:
   1. `dirname(process.execPath)/native/ffi/<triple>/lib<name>.so`, where `<triple>` is the
      runtime's Rust target triple (platform, arch, and musl vs glibc detected the way the sharp
      shim's `runtimePlatformIds()` does). This is every Bun image shape (Context fact 3; ADR-0060
      I2). Integrity is checked here, **fail-closed** (jev: fail closed **0.95**, warn 0.05): the
      library must be listed in `native/.integrity.json` (schema version 1) under
      `ffi/<triple>/lib<name>.so` and its sha256 must match; an absent manifest, an unlisted
      library or a mismatch is fatal. No ffi image predates the manifest, so the sharp shim's
      warn-on-absence exception does not apply. (Consequence: a local `bun --bun next start` after a
      plain `next build` has no `native/` beside the Bun binary and is refused with the paths tried;
      `next dev` and images built by `knext build` are the supported paths.)
   2. Only when `NODE_ENV !== 'production'`: the host build in the crate directory
      (`<cwd>/<crate>/target/{release,debug}/lib<name>.{dylib,so}`, newest first), with a one-line
      development notice and no integrity check. This is what makes `bun --bun next dev` work.
   3. Otherwise `FfiLoadError` listing every path tried and naming `knext ffi build`.

   There is no environment-variable override in v1: every production path is the integrity-checked
   one.

   **Dynamic contexts only.** A call made while `next build` prerenders fails, by construction:
   the build runs with `NODE_ENV=production` (so path 2 is off) and `process.execPath` is the
   Node or Bun install directory, which has no `native/ffi/` beside it (so path 1 misses); under a
   Node build the Bun check fails even earlier. v1 therefore supports calls from **dynamic
   contexts only**: Server Actions, route handlers, and dynamically rendered pages and layouts. A
   call reached from a statically prerendered page, `generateStaticParams`, `generateMetadata` of a
   static route, or anything else evaluated at build time is unsupported. The loader detects the
   build (`process.env.NEXT_PHASE === 'phase-production-build'`), checks it **before** the Bun
   check so it is the message a developer sees, and throws an `FfiLoadError` that says, in one
   message: the call happened during `next build` prerendering; in-process Rust runs only at
   request time, not in prerendering, `generateStaticParams` or `generateMetadata` of a static
   route; and how to make the route dynamic (`export const dynamic = 'force-dynamic'` in the
   route segment, or `await connection()` from `next/server` before the call). The docs page
   (#2348) states the same rule and the same two fixes. A loader test sets `NEXT_PHASE` and asserts
   that message wins over the not-Bun and not-found messages.
6. One preallocated 16-byte out slot and one growable UTF-8 scratch buffer per module instance
   (each Worker has its own), reused across calls; JavaScript is single-threaded per isolate and v1
   has no re-entrancy (the spike ran 4 Workers concurrently). **Several string, bytes or JSON
   arguments share that one scratch buffer** (jev: one buffer, pointers from final offsets
   **0.99**, a buffer per argument 0.01), in two phases:
   1. **Encode every argument first.** Each argument is written into the scratch buffer at the
      next free offset (8-byte aligned), recording only its `(offset, length)`. When the next
      argument does not fit, the buffer grows (a new, larger `ArrayBuffer`, the bytes so far copied
      over), which moves every earlier argument's bytes.
   2. **Then compute every pointer**, from the final buffer, as `ptr(finalBuffer) + offset`,
      immediately before the call, with nothing allocated in between. No pointer is ever taken
      before the last grow, so none can point into a buffer a grow replaced.

   `Uint8Array` arguments are copied into the scratch buffer the same way (one rule for every
   (ptr, len) pair); an empty one (of any kind: string, bytes or JSON) is passed as `null` (below)
   and takes no space. A
   generator test calls a two-argument export with **two large string arguments** whose combined
   size forces at least one grow between the first and the second encode (the first fits the
   current buffer, the second does not), and asserts Rust received both strings byte-for-byte; a
   mutation that takes the first pointer before encoding the second must turn it red. Binding
   rules from the spike, each with a generator unit test:
   - **create the `ArrayBuffer` first and take `ptr()` of it** (`const b = new ArrayBuffer(16);
     const OUT_PTR = ptr(b)`), never `ptr()` of a small typed array whose `.buffer` is read later:
     JavaScriptCore moved that storage and Rust then wrote into freed memory;
   - read returned `(pointer, length)` pairs as two `u32` halves, not through a `BigInt`;
   - decode returned strings with a length-bounded read (`new CString(ptr, 0, len)` was fastest and
     honours embedded NULs), copy returned bytes into a fresh `Uint8Array`, then free;
   - pass JavaScript `null` as the pointer of every zero-length argument; never call `ptr()` on
     an empty array (it throws), and never pass the empty array itself: on Bun 1.4.2 it arrives
     **non-null** (measured during FFI-2; the spike's "arrives as NULL" was wrong). The shim
     ignores the pointer when `len == 0` either way (D4);
   - **validate integer arguments** (jev: always **1.00**, development only 0.00, never 0.00):
     `bun:ffi` silently truncates a JavaScript number passed to an `i32`, so a non-integer or
     out-of-range `number`, or an out-of-range `bigint`, throws a `TypeError` naming the argument
     before the call. It costs a few nanoseconds.
7. One exported, typed function per Rust export, with the Rust doc comment carried over as TSDoc,
   plus the record interfaces, enum unions, and the three error classes.

### D14. Build and image (jev: host `cargo zigbuild` **1.00**, Docker stage 0.00, `cross` 0.00; `native/ffi/<triple>/` **0.99**, separate tree 0.00, embed 0.01; refuse self-contained mode **0.84**, extract to temp 0.15)

`knext build`, when `knext.ffi.json` exists and the resolved runtime is Bun, runs these steps
**before** the project build (`next build`/`vite build`):

1. Dispatch `knext ffi build --target <triple> --native-dir <app>/native` to `@getknext/ffi`, where
   `<triple>` maps from the image arch the build already uses: `linux-x64` →
   `x86_64-unknown-linux-musl`, `linux-arm64` → `aarch64-unknown-linux-musl`.
2. That runs `cargo zigbuild --release --locked --target <triple>` in the crate directory with
   `RUSTFLAGS=-C target-feature=-crt-static` (Context fact 6), with the crate's pinned
   `rust-toolchain.toml`. Missing `cargo`, `cargo-zigbuild`, `zig` or the rustup target is a
   `UsageError` that names the install command. zig supplies the musl sysroot that a plain
   `cargo build` on a non-Alpine host lacks (measured: `rust-lld: unable to find library -lc`).
   **Named fallback:** if FFI-4 shows zigbuild's output does not load on Alpine, `knext ffi build`
   switches to a host-orchestrated container build (`docker run` of a digest-pinned
   `rust:*-alpine` image with the crate mounted, output written to the host), which keeps the
   "built on the host side, hashed before the image build" property; that switch is recorded as an
   amendment to this ADR.
3. **libc check:** parse the ELF `DT_NEEDED` entries of the built library and refuse anything not
   on an allowlist of `libc.so` (what zigbuild emits, measured), `libc.musl-<arch>.so.1`,
   `ld-musl-<arch>.so.1` and `libgcc_s.so.1` (present anyway: every knext Bun stage runs
   `apk add --no-cache libstdc++ libgcc`). `libc.so.6`, `ld-linux-*` or any other library fails the
   build by name. A glibc-linked library on a musl image is the crash this prevents.
4. **Stage** to `native/ffi/<triple>/lib<name>.so`, clearing only `native/ffi/` (never the sharp
   staging beside it), plus `native/ffi/<triple>/provenance.json`: crate name and version, the
   sha256 of `Cargo.lock`, `rustc -V`, `cargo zigbuild --version`, target, profile, and the
   `knext-ffi` rev.
5. **Drift check:** scan the staged library's manifest (D5), regenerate in memory, and compare with
   the committed `<out>/index.ts`. A difference fails the build with "run `knext ffi generate`".
   The wrapper in the image is therefore always the one generated from the library in the image.

Then the normal build continues. Steps 1–5 and the D15 preflight must run for **every** command
that builds an image, not only `knext build`: `knext deploy` and `knext preview` build through the
same `runProjectBuild` (`project-build.ts`). **The D15 refusals do not go there** (round 3):
`runProjectBuild` is skipped by `knext deploy --skip-build` and `knext build --skip-next`,
and it never sees the resolved `selfContained` (that is resolved from config plus
`--self-contained` inside `compileArtifactForDeploy`). Nor do they go in
`compileArtifactForDeploy` alone (round 4): `knext deploy --skip-build` never calls it (that leg
calls `assertCompiledArtifactFresh` instead). Both refusals live in **one shared preflight**,
`assertFfiTargetSupported`, which resolves the runtime and `selfContained` with the same resolver
`compileArtifactForDeploy` uses and is called **first** in each of `knext build`, `knext deploy` and
`knext preview`: before the ffi dispatch, before any `cargo` or Next build, and before the
skip-build branch (jev 0.95). So it also stops before any build work for `selfContained`, not only
for Node. Tests cover `knext deploy --skip-build` and `knext build --skip-next` with an
opted-in `runtime: 'node'` app and with `selfContained: true`, each refused before any build or
image step; a scan test asserts each of the three callers calls the preflight before anything else. The dispatch (steps 1–5) runs in each of the three callers
before `runProjectBuild` (it is async, `runProjectBuild` is not), and a test scans the three for it.

**The integrity manifest, per cell.** `writeNativeIntegrityManifest` hashes the whole `native/`
tree with no change to the writer (Context fact 5), but it has to be **called**, and today it is
called from one place only, `stageSharpNative` (`vinext-build.ts`, inside the vinext compile):

- `vinext × bun`: covered. `stageSharpNative` runs after step 4 and writes the manifest over
  `native/`, including `native/ffi/**`.
- `turbopack|webpack × bun`, disk mode: **no call site exists**. `build.ts` has no `native/`
  step, and the standalone compile stages nothing there. #2345 adds the call in
  `compileArtifactForDeploy` (`build-artifact.ts`, the step `knext build`, `knext deploy` and
  `knext preview` share), in the standalone branch, after `buildStandaloneExecutable` and before
  `writeBuildStamp`, only when `knext.ffi.json` exists:
  `writeNativeIntegrityManifest(join(cwd, "native"), lockfilePath)`. The tree then holds no
  `@img` packages, so the writer's lockfile pin check has nothing to pin. A test asserts that an
  opted-in standalone build leaves a `native/.integrity.json` listing `ffi/<triple>/lib<name>.so`
  with the right sha256, and a mutation that removes the call turns it red.

Image changes:

- `vinext × bun`: none — `COPY native /app/native` already ships it beside `/app/server`.
- `turbopack|webpack × bun`, disk mode: the image needs
  `COPY native /app/.next/standalone/native` in the `standalone-bun` stage, so the tree sits
  beside `/app/.next/standalone/knext-standalone-exec` (D13 path 1). `Dockerfile.standalone.hbs`
  is copied verbatim and `stageStandaloneBuildContext` (`runtime-image.ts`) refuses any `{{ }}` in
  it, so this is not a template conditional: when `knext.ffi.json` exists,
  `stageStandaloneBuildContext` inserts that one line directly after the stage's
  `COPY knext-standalone-exec-linux-x64 /app/.next/standalone/knext-standalone-exec` line,
  asserting the anchor occurs exactly once in the `standalone-bun` stage and failing the build
  otherwise. The condition is the file, not the presence of `native/ffi/`, so a stale tree from an
  earlier opted-in build is never shipped by an app that has since opted out. Without the file the
  staged Dockerfile is byte-identical to today's (D17). **Nested (monorepo tracing-root) layout**
  (rounds 3–4): the insertion happens **before** `nestStandaloneDockerfile` runs, and the rule list
  it applies is built **conditionally**: only when `knext.ffi.json` exists does it include a
  `NEST_RULES` entry (`runtime-image.ts`, `count: 1`) that rewrites the inserted line to
  `COPY <prefix>native /app/.next/standalone/<prefix>native`, so `native/` stays beside the
  nested `<prefix>knext-standalone-exec`. Every rule keeps its exact count, and a non-ffi app's
  rule list and nested Dockerfile are unchanged (jev 0.91 vs count 0-or-1 or reusing the exec
  rule's append lines). The nested-layout test covers both: an opted-in app gets the rewritten line,
  and a non-ffi app's nested Dockerfile is byte-identical to today's; a mutation that drops the
  rule turns the first red. Both the manifest call above and this line
  are **#2345's scope**.
- `selfContained: true` with `knext.ffi.json`: **refused** at build time in v1. That mode promises
  nothing beside the binary, and embedding needs a writable temp directory (Context fact 4).
- vinext's `native/` clean-up (`vinext-build.ts`, "clear the previous build's staging out of
  `native/` — and only that") must keep leaving `native/ffi/` alone; a test pins it.

Build matrix: `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` first (the shipped
images). glibc targets are later work. macOS (`aarch64-apple-darwin`) is a development host only,
reached through `knext ffi generate`'s host build. Linux musl loading is proved by a CI job, not on
a developer machine (D20).

### D15. Refusing Node, in two places (jev: build preflight and runtime guard **0.95**, build only 0.05, runtime only 0.00)

1. **Build (core).** The shared preflight `assertFfiTargetSupported`, called first in `knext build`, `knext deploy` and `knext preview`, including their skip-build paths (D14, round 4): if
   `knext.ffi.json` exists and the resolved runtime is `node` (any builder), stop before any build
   work with:

   ```
   knext: in-process Rust (bun:ffi) needs the Bun runtime, but this app builds for Node.

     knext.ffi.json opts this app into in-process Rust, and knext.config.ts resolves
     runtime: 'node'. bun:ffi exists only in Bun, so the build stops here instead of
     shipping an image whose Rust calls would fail on the first request.

     Fix one of:
       - use the Bun runtime: remove runtime: 'node' from knext.config.ts (Bun is the default);
       - or move this code to a zone function (knext add function <name> --lang rust),
         which runs on both runtimes.
   ```

   The same preflight refuses `selfContained: true` (D14) with its own message.
2. **Runtime (generated code).** On the first call, if `process.versions.bun` is absent:
   `FfiLoadError("In-process Rust (bun:ffi) runs only on Bun; this process is Node <version>. Run
   the app with Bun (bun --bun next dev), or call this code through a zone function.")`. This covers
   `next dev`/`next start` under Node, which the build check cannot see.

### D16. Supply chain (jev: full set **1.00**, `cargo audit` only 0.00, nothing 0.00)

- `Cargo.lock` committed; every build `--locked`; toolchain pinned.
- **The build tools are pinned too**, because each one runs with the build host's credentials and
  writes bytes that ship:
  - **zig**: an exact version, downloaded from `ziglang.org` by URL and verified against a
    sha256 per host platform (`linux-x86_64`, `linux-aarch64`, `macos-aarch64`) recorded in
    `@getknext/ffi`; a mismatch fails closed, the same way the patched Bun toolchain is verified.
    A `zig` already on `PATH` is accepted only if its `zig version` equals the pin.
  - **`cargo-zigbuild`, `cargo-deny`, `cargo-auditable`, `cargo-cyclonedx`**: installed with
    `cargo install --locked --version <exact>` (the `--locked` makes `cargo install` use each
    tool's own published `Cargo.lock`). The exact versions live in one table in
    `@getknext/ffi`; the `UsageError` for a missing tool (D14 step 2) prints that exact command,
    and `knext ffi build` refuses a tool whose `--version` differs from the pin.
  - The four versions and the zig version/hashes are recorded in `provenance.json` (D14 step 4).
  - Bumps are deliberate PRs that change the table and its test, not a floating `latest`.
  This is **#2347's scope** (the pin table, the verification, the install command in the message,
  and a test per tool that a wrong version is refused).
- `knext ffi init` writes a `deny.toml`, and **`knext ffi build` runs `cargo deny check`** before
  compiling (advisories, licenses, bans, sources — git sources allowlisted to `getknext-dev/knext`
  only), so every image build is gated without touching core's CI generators. Any advisory not in
  the zone's dated, justified allowlist fails the build, mirroring
  `security/npm-audit-allowlist.json`.
- The library is built through **`cargo auditable`** (the dependency list embedded in the `.so`,
  which Trivy and syft read), so the image scan sees the Rust crate graph that the npm SBOM cannot.
  Whether `cargo auditable` composes with `cargo zigbuild` (both wrap cargo) is unverified: FFI-5
  proves it or records the measured failure and relies on the SBOM below.
- A **CycloneDX SBOM** of the crate graph (`cargo cyclonedx`) is written to
  `native/ffi/<triple>/sbom.cdx.json`, so it ships in the image and is hashed with everything else.
- **Provenance:** `provenance.json` (D14) travels inside `native/`, so it is hashed into
  `native/.integrity.json`; any signature or attestation over the image covers both, and the loader
  re-checks the library's hash at run time.
- **Integrity at load:** fail-closed sha256 check (D13).
- `crates/` itself gets `cargo deny check`, `cargo test`, `cargo clippy -D warnings` and
  `cargo fmt --check` in CI.

### D17. Compatibility-suite impact and the zero-diff guarantee

- Core's runtime is unchanged: no adapter, cache handler, server entry or supervisor change. The
  generated module is app code. So the credential cells (which build Next's own fixtures, not an
  ffi app) are unaffected by construction.
- Every core change is **inert without `knext.ffi.json`**: the build preflight, the dispatch to
  `@getknext/ffi`, and the conditional `COPY` line. A test builds a fixture app without the file and
  asserts the staged Dockerfile and `native/` tree are byte-identical to today's.
- The feature is **not** covered by the compatibility credential and says so in its docs.
- **An app that uses the feature still passes the Bun cells' checks** (#2315 asks for this; jev:
  compat-smoke capability checks on the e2e fixture **0.89**, a full compat dispatch per change
  0.08, no gate 0.03). The #2346 kind e2e's Bun fixture zone, the one whose Server Action calls a
  Rust export, also runs the existing compat-smoke capability checks: the same runner
  (`apps/file-manager/scripts/compat-smoke.mjs`) and checks the `compat-smoke` CI job runs,
  red-on-fail, with no `skip()` and no `continue-on-error`. Those checks assert the reference
  app's routes, so the fixture is `apps/file-manager` **copied into the e2e workspace** with the
  opt-in added (`knext.ffi.json`, a `rust/` crate, one Server Action calling a Rust export); the
  reference app itself is not changed. It is built by `knext build` on the default
  `turbopack × bun` cell, and the runner is pointed at that build's executable through
  `SERVER_CMD`/`SERVER_PATH`, as the CI job does, before the same build is deployed to kind for
  the e2e assertions. A failing capability check fails the e2e job. So "opting in does not break
  the Bun cell" is a red-on-fail check on an app that actually opts in, not an argument.
- **Why not a full compatibility-suite dispatch:** a dispatch takes the whole runner pool for about
  an hour, and the official suite builds **Next.js's own fixture apps**, not a knext zone, so it
  would never load a Rust library: it would spend an hour proving nothing about this feature. The
  credential cells are unaffected by construction (first bullet), and the smoke checks above run
  on the app that is affected.

### D18. Core-vs-app boundary

- Core (`packages/kn-next`) never depends on Rust, never imports `@getknext/ffi` statically, never
  parses `knext.ffi.json`, and contains no Rust-specific logic beyond: the file's existence check,
  the target-triple mapping it passes on, the Node and self-contained refusals, and the conditional
  `COPY` line. Everything that knows Rust is in `@getknext/ffi` and `crates/`.
- The generated module and the zone's crate are **app code**, owned by the app.
- A guard test (in core) asserts no `bun:ffi`, `cargo`, `zigbuild` or `@getknext/ffi` static import
  appears under `packages/kn-next/src`, mirroring `grpc-dispatch.test.ts`.

### D19. Graduation from Beta (jev: Bun's docs **and** knext's gates **0.95**, Bun's docs only 0.03, knext's gates only 0.02)

The feature leaves Beta when **both** hold:

1. Bun's docs drop the experimental / "Do not rely on it in production" status of `bun:ffi` (the
   founder's trigger), on a Bun release knext pins; and
2. knext's own gates are green on that release: the kind e2e and the musl x64/arm64 load jobs (D20).

The watch is mechanical: an entry in the upstream-retirement registry
(`tests/upstream-retirement/registry.ts`) whose probe reads the pinned `bun-types` package's
`docs/runtime/ffi.mdx` and asserts the notice is still there. When a Bun bump removes it, that test
goes red and forces the graduation PR (an amendment to this ADR, the label removed everywhere D2
lists). The registry's marker scan is extended to `packages/ffi/src` so the entry has a marker.

### D20. Gates (what "done" means for the build)

- `crates/`: unit tests for every D6 row; `trybuild` compile-fail tests for every rejected type and
  for `panic = "abort"`; a panic test (process survives, next call works); the leak test (1e6 calls,
  RSS growth under a fixed bound, and a deliberately leaking variant that the same check catches).
- `@getknext/ffi`: generator golden tests per D6 row; scanner tests over synthetic blobs and a real
  library; `check` drift tests; loader tests for each D13 path-resolution and integrity branch;
  `--help` with and without the package installed.
- Core: the Node refusal, the self-contained refusal, the zero-diff test (D17), the boundary guard
  (D18), and the "vinext clean-up keeps `native/ffi/`" test. Each mutation-proved.
- CI: a **musl load job** on `x86_64` and `aarch64` (GitHub's arm runners) that cross-builds the
  fixture crate with `cargo zigbuild`, runs it in `oven/bun:1.4.2-alpine` with a read-only root
  file system, and calls every fixture export. It must prove the two inferred facts first: that
  musl's loader resolves the library's `NEEDED libc.so`, and that a panic unwinds through zig's
  statically linked libunwind into `catch_unwind` (status 2, process alive).
- **kind e2e on a Bun zone:** a fixture zone whose Server Action calls a Rust function, built by
  `knext build`, deployed with `knext deploy`, invoked over HTTP; asserts the result, a `RustError`
  and a `RustPanicError` path (pod not restarted), and that the Node runtime is refused at build.
  The same fixture's build also passes the compat-smoke capability checks, red-on-fail (D17).
- Docs: one Beta page (no issue, PR or ADR numbers; `content-hygiene.test.ts`).

## Options considered

| Criterion | **`bun:ffi` + macro + generator (chosen)** | napi-rs N-API addon | WebAssembly | Zone function only |
|---|---|---|---|---|
| Runtimes | Bun only | Node and Bun (measured, one `.node`) | Node and Bun | Node and Bun |
| Per-call cost (M1 Pro) | `add` ~10 ns through the generated wrapper; strings 0.3–2 µs; records 1–3 µs (this spike) | `add` 77 ns on Bun, 107 ns on Node (2026-10-13 research) | `add` ~4 ns, scalars only; data must be copied into linear memory | ~5–8 ms warm, ~1.4 s cold |
| Upstream stability | **experimental** ("do not rely on it in production") | stable; long tail of Bun napi crash issues | stable; napi-rs WASI unsupported on Bun | stable |
| Typed TS | generated by us (this ADR) | generated by napi-rs | manual or wasm-bindgen | generated from proto |
| Panic safety | `catch_unwind` in every shim (D4) | only with `#[napi(catch_unwind)]`; default aborts (measured) | trap, process survives | function pod only |
| Single-exec loading | `native/` beside the exe, absolute path | same, `process.dlopen` | plain bytes, no dlopen | n/a |
| Build burden | `.so` per musl target, zig cross-build | `.node` per target | one artifact | one image per function |
| Crash radius | zone pod | zone pod | none (trap) | function pod |
| Founder fit | **matches the decision** | overruled (Node + Bun was the research's pick) | not chosen; fenced out of 2.0 by ADR-0002 | complementary, not a substitute |

Why not napi-rs, given it is stable and runs on Node too: the founder chose `bun:ffi` (#2315,
2026-10-14) and accepted the Beta label as the cost. This ADR records that choice and contains its
risk (Beta, opt-in, integrity-checked, panic-safe, zero-diff for everyone else).

## Consequences

**Positive**

- Hot Rust code runs in-process with a typed TS API and no network hop or extra cold start.
- The manifest is part of the shipped binary, so the wrapper in an image is provably the one for the
  library in that image (D5, D14 step 5), and a stale wrapper cannot call a changed signature (D4).
- No core runtime change; every core change is inert without opt-in (D17).

**Negative / risks**

- **Upstream risk:** `bun:ffi` may break or change in a Bun release; Bun even says a future version
  may add a flag to disable it. Mitigated by Beta, by the Bun pin (knext pins Bun per release) and
  by the gates in D20 running on every Bun bump.
- **Crash radius:** a segfault, abort or stack overflow in Rust (or in `unsafe` code it calls) kills
  the whole zone pod, and with it every in-flight request. `catch_unwind` covers panics only.
- **Event-loop blocking** (D10) is a footgun the docs must make loud.
- **Node users cannot use it.** The refusal is explicit, and zone functions are the portable path.
- **Build-host burden:** Rust, `cargo-zigbuild` and `zig` on the build host (CI images included)
  for any zone that opts in.
- **A new optional package** (`@getknext/ffi`) and two crates to maintain; crates.io and npm
  publication are founder actions.
- **Unverified until the tickets run:** the musl load on real Alpine images (Docker on the spike
  machine is out of disk), including `NEEDED libc.so` resolution and a panic unwinding through
  zig's libunwind; `cargo auditable` with `cargo zigbuild`; and the OKE behaviour with a read-only
  root file system. D14 names the fallback if the first fails.

## Action items

Milestone v2.0, `priority:P1`. File ownership is disjoint, so FFI-1, FFI-2, FFI-3 (core side),
FFI-5 (standalone gates) and an FFI-6 draft can run in parallel from day one.

| Ticket | Scope | Depends on |
|---|---|---|
| **#2343 FFI-1** | `crates/knext-ffi` + `crates/knext-ffi-macros`: D3, D4 (including the transitive `_schema` hash), D5, D6, D7 (64-bit as a decimal string in every JSON position), D8 (Rust half), D9; trybuild, panic and leak tests; `rust-crates.yml` CI | — |
| **#2344 FFI-2** | `@getknext/ffi`: `knext ffi init/generate/check`, `knext.ffi.json`, scanner, emitter, generated loader (D11–D13, D15 runtime half), including the two-phase multi-argument marshalling (D13 item 6), the per-position 64-bit codec (D7), the `_schema` check at load (D4) and the prerendering `FfiLoadError` (D13 step 5); core `ffi-dispatch.ts` + help; D18 guard; D19 registry entry | — (its real-library test waits for #2343) |
| **#2345 FFI-3** | `knext ffi build` (D14 steps 1–5) and core: Node and self-contained refusals (D15) in the shared `assertFfiTargetSupported` preflight called first by build/deploy/preview (round 4; tests for `deploy --skip-build`/`build --skip-next`), dispatch before the project build in `build`/`deploy`/`preview`, the standalone-path `writeNativeIntegrityManifest` call in `compileArtifactForDeploy` and the inserted `COPY native /app/.next/standalone/native` line in `stageStandaloneBuildContext`, inserted before nesting, plus its conditional `NEST_RULES` entry and a nested-layout test covering opted-in and non-ffi apps (D14), zero-diff test (D17) | #2344 (dispatch protocol, `renderModule`); #2343 for a real library in tests. Core-side work starts at once against a fake loader |
| **#2346 FFI-4** | musl load matrix on Alpine x64/arm64 with a read-only root; kind e2e of a Server Action calling Rust on a Bun zone; Node refusal asserted (D20); the same fixture passes the compat-smoke capability checks, red-on-fail (D17) | #2343, #2344, #2345 merged; fixture and workflow skeleton can be written in parallel |
| **#2347 FFI-5** | supply chain: `cargo deny`, `cargo auditable` (prove it composes with zigbuild), CycloneDX SBOM, `deny.toml` template, and the build-tool pins (zig version + sha256, `cargo install --locked --version` for the four cargo tools) (D16) | #2345 for the one call site only |
| **#2348 FFI-6** | user docs page (Beta), including the dynamic-contexts-only rule and the two ways to make a route dynamic (D13 step 5), and the `knext ffi` CLI reference | #2344, #2345 for the final surface; a draft can start now |

Dependency edges: #2343 → #2344 (real-library test only) → #2345 (drift check) → #2346;
#2343 → #2345 (test library); #2345 → #2347 (call site); #2344 + #2345 → #2348.

Shared files, so disjoint ownership holds by section, not by file:

- `apps/docs/content/docs/cli.mdx`: **#2345** owns the text it adds under the existing `knext build`
  section (the opt-in behaviour and the Node and self-contained refusals); **#2348** owns the new
  `knext ffi` section. Different sections of one file; whichever merges second rebases.
- `packages/ffi/src/build.ts`: **#2347** shares exactly one line with **#2345** (the `cargo`
  invocation that `knext ffi build` wraps with `cargo auditable`). Sequenced: #2347 adds it after
  #2345 merges; the rest of #2347 lives in `supply-chain.ts`.

Founder actions, not tickets: publishing `@getknext/ffi` to npm and the crates to crates.io, which
also moves D3's git `rev` pin to a crates.io version.
