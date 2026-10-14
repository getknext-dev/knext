# knext in-process Rust crates (Beta)

Two crates that let a Bun zone call Rust **inside its own process** through
`bun:ffi`, with a generated, typed `server-only` TypeScript wrapper:

| Crate | What it is |
|---|---|
| [`knext-ffi`](knext-ffi) | the runtime: ABI v1 types and constants, `knext_ffi_v1_free`, `knext_ffi_v1_abi`, panic and error plumbing, the JSON wire format (64-bit integers as decimal strings), and re-exports of the macros, `serde` and `serde_json` |
| [`knext-ffi-macros`](knext-ffi-macros) | `#[knext_ffi::export]` on a `pub fn` and `#[knext_ffi::record]` on a struct or unit enum |

The design and every decision behind it is **ADR-0069**
(`docs/adr/0069-bun-ffi-inprocess-rust.md`); this README states the contract
the crates implement and points at the ADR section that owns each part. The
feature is **Beta** while `bun:ffi` is experimental upstream, Bun-only, and not
covered by the compatibility credential. The TypeScript generator, the
`knext ffi` CLI and the loader live in `@getknext/ffi` (`packages/ffi`).

## Using the crates from a zone (ADR-0069 D3)

A zone keeps its Rust in `rust/` (a `cdylib`). Until the crates are published to
crates.io, depend on them **by git revision**, never a branch or tag (a tag can
be moved):

```toml
[lib]
crate-type = ["cdylib"]

[dependencies]
knext-ffi = { git = "https://github.com/getknext-dev/knext", rev = "<40-hex commit>" }
```

`knext ffi init` writes this line with the revision the installed
`@getknext/ffi` release records, so the macro and the generator always agree on
ABI version 1. Inside this repository (fixtures, tests) a `path` dependency is
used instead. Publishing to crates.io is a maintainer action and changes only
that one line.

```rust
use knext_ffi::{export, record};

#[record]
pub struct Point { pub id: u64, pub label: String }

/// Says hello.
#[export]
pub fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}
```

Do **not** set `panic = "abort"` in the crate's profile: `knext-ffi` refuses to
compile with it, because a panic would then kill the Bun process instead of
reaching JavaScript as a `RustPanicError`.

## ABI v1 (ADR-0069 D4)

Every symbol the wrapper binds starts with `knext_ffi_v1_`, so a library of
another ABI version fails `dlopen` by name.

- **Shim** per export: `knext_ffi_v1_<fn>_<h>(<lowered args>, out: *mut [u64; 2]) -> i32`,
  where `<h>` is FNV-1a 32-bit of the canonical signature `sig` (below), as 8
  lowercase hex digits. A wrapper generated before a signature change fails
  `dlopen` with a missing symbol.
- **Schema check** per export: `knext_ffi_v1_<fn>_<h>_schema() -> u64`, a
  compile-time FNV-1a 64-bit of the **schema string**: `sig` followed by the
  canonical form of every record and enum the function can reach, at any
  depth. The loader calls it once after `dlopen` and compares it with the value
  the generator computed from the manifest; a mismatch is a stale wrapper. So
  renaming, retyping, reordering, adding or removing a field or variant anywhere
  the function can reach is detected at load.
- `knext_ffi_v1_free(ptr: *mut u8, len: usize)`: frees a returned buffer.
  `(NULL, 0)` is a no-op.
- `knext_ffi_v1_abi() -> u32`: returns `1`. (Named by the implementation
  ticket, not by the ADR; binding it is optional.)

**Arguments**, left to right: integers, floats and `bool` as one argument of
the same C type (`usize`/`isize` are 64-bit; ABI v1 is 64-bit little-endian
only, enforced at compile time). `String`, `&str`, `Vec<u8>`, `&[u8]` and every
JSON type as two arguments `(ptr: *const u8, len: usize)`. **When `len == 0`
the pointer is never read**, whether it is NULL or any other value (Bun may pass
a non-null pointer for an empty typed array; the generated wrapper passes NULL).

**Status** (`i32`): `0` OK, `1` `Err` from a `Result` (message = `e.to_string()`),
`2` panic (message = the panic payload, or `panic with a non-string payload`),
`3` invalid input (bad UTF-8, or JSON that does not decode as the declared
type; the message names the argument).

**Out slot** (16 bytes, caller-owned): a scalar return at offset 0, little-endian,
native width (`bool` is one byte, 0 or 1); a `String`/`Vec<u8>`/JSON return,
and every status 1–3 message, as `out[0]` = pointer, `out[1]` = length of a
Rust `Box<[u8]>`; `(0, 0)` for an empty value, which allocates nothing and is
not freed; nothing at all for a `()` return.

**Panics**: every shim body runs inside `catch_unwind`; nothing unwinds across
the boundary. Rust's default panic hook stays, so the panic location is printed
to stderr. An abort, a segfault, a stack overflow or `process::exit` still ends
the process.

**Ownership (ADR-0069 D9)**: arguments are borrowed for the call only (an owned
`String`/`Vec<u8>` parameter costs one copy; prefer `&str`/`&[u8]`); every
non-empty returned buffer is one allocation that the wrapper frees exactly once
with `knext_ffi_v1_free`, after copying it.

## Type table (ADR-0069 D6)

| Rust (argument or return) | TypeScript | How it crosses |
|---|---|---|
| `i8` `i16` `i32` `u8` `u16` `u32` | `number` | by value |
| `i64` `u64` `isize` `usize` | `bigint` | by value |
| `f32` `f64` | `number` | by value |
| `bool` | `boolean` | by value |
| `String`, `&str` | `string` | UTF-8 (ptr, len) |
| `Vec<u8>`, `&[u8]` | `Uint8Array` | (ptr, len) |
| `()` (return) | `void` | — |
| `#[knext_ffi::record] struct` | `interface` | JSON |
| `#[knext_ffi::record] enum` (unit variants) | string-literal union | JSON |
| `Option<T>`, `Vec<T>` (`T` ≠ `u8`) | `T \| null`, `T[]` | JSON |
| `Result<T, E>` (return only), `E: Display` | `T`; `Err` throws `RustError` | status 1 |

Anything else is a compile error that names the type and points at this table:
generics and lifetime parameters, `char`, `i128`/`u128`, tuples, arrays, raw
pointers, `impl Trait`, function pointers, `async fn`, methods, `unsafe fn`,
references other than `&str`/`&[u8]` (and any returned reference),
`Result` as an argument, data-carrying enums, generic or recursive records, and
`#[serde(...)]` attributes on a record. A function that names a type which is
not a `#[knext_ffi::record]` fails with "`T` is not a #[knext_ffi::record] type".
Mutually recursive records fail with a const-evaluation cycle error.

## Records and JSON (ADR-0069 D7)

`#[record]` derives serde's `Serialize`/`Deserialize` through `knext_ffi`'s
re-export (the zone does not depend on serde itself), with unknown fields
refused. Field and variant names cross verbatim. **Every 64-bit integer in any
JSON position** (a record field, an `Option`/`Vec` element at any depth, a
top-level `Option<u64>` or `Vec<i64>`) is a **decimal string**, and a JSON number
there is refused (status 3). Inside JSON, `Vec<u8>` is an array of numbers.
Floats must be finite (a non-finite float serializes as `null`, which the
generated decoder refuses).

## Embedded manifest (ADR-0069 D5)

Each export and each record type embeds one exported static: the 9 bytes
`KNEXTFFI1`, one JSON object, and a NUL. The generator scans the library file's
bytes (it never loads it), so a cross-compiled musl library can be scanned on
macOS. The records survive `lto = true`, `strip = true`, `codegen-units = 1`
and `opt-level = 3` (checked in CI). Shapes:

```json
{"v":1,"kind":"fn","name":"greet","symbol":"knext_ffi_v1_greet_8a119d0c","sig":"greet(string)->string","doc":"Says hello.","args":[{"name":"name","type":{"t":"string"},"rust":"&str"}],"ret":{"type":{"t":"string"},"rust":"String"},"err":null}
{"v":1,"kind":"record","name":"Point","doc":"","fields":[{"name":"id","type":{"t":"u64"},"rust":"u64"}]}
{"v":1,"kind":"enum","name":"Color","doc":"","variants":["Red","Green"]}
```

## Canonical strings (shared with the generator)

The generator derives both strings from the manifest's type descriptors and
never parses Rust, so the grammar is defined on descriptors:

- **type token**: `i8` … `usize`, `f32`, `f64`, `bool`, `string`, `bytes`,
  `unit`; a record or enum is its name; `option<TOKEN>` and `vec<TOKEN>`
  recurse. Inside JSON, `Vec<u8>` is `vec<u8>`; `bytes` appears only as a
  top-level argument or return.
- **`sig`**: `name(TOKEN,TOKEN,…)->TOKEN`, no spaces; a `()` return is `unit`;
  `Result<T, E>` is spelled as `T`. Example: `mid(Point,Point)->Point`.
- **schema string**: `sig`, then every record and enum reachable from the
  arguments and return (transitively, deduplicated by name), **sorted by name
  byte-wise, records and enums together, no separators**. A record is
  `Name{field:TOKEN,…}` in declaration order; an enum is `Name[A|B|C]`.

Golden pairs (pinned by `knext-ffi-fixture/tests/abi.rs` and by the Bun harness):

| string | hash |
|---|---|
| `add(i32,i32)->i32` (FNV-1a 32) | `43c960c6` |
| `add(i32,i32)->i32` (FNV-1a 64) | `0x29df491fa1e52ca6` |
| `next_color(Color)->ColorColor[Red\|Green\|Blue]` (FNV-1a 64) | `0xa34dde499fdb102f` |

## Tests and CI

`.github/workflows/rust-crates.yml` runs on changes under `crates/`:
`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` and
`cargo deny check` (all `--locked`), then the Bun harness
(`harness/ffi-harness.ts`) on Linux x64 against the release-profile fixture
library. Locally:

```sh
cd crates
cargo test --workspace
cargo build --release -p knext-ffi-fixture
bun harness/ffi-harness.ts manifest  target/release/libknext_ffi_fixture.dylib   # .so on Linux
bun harness/ffi-harness.ts roundtrip target/release/libknext_ffi_fixture.dylib
bun harness/ffi-harness.ts panic     target/release/libknext_ffi_fixture.dylib
bun harness/ffi-harness.ts leak      target/release/libknext_ffi_fixture.dylib            # exit 0
bun harness/ffi-harness.ts leak      target/release/libknext_ffi_fixture.dylib --no-free  # exit 3
node scripts/mutation-prove.mjs   # each key guard goes red when its behaviour is removed
```

| Test | What it proves |
|---|---|
| `knext-ffi-fixture/tests/abi.rs` | every type-table row as argument and return, through the shims as C sees them; golden symbol names and `_schema` values; status 1/2/3; a thousand panics in a row; `len == 0` with a NULL or dangling pointer |
| `knext-ffi-fixture/tests/ownership.rs` | a counting allocator: returned buffers are released exactly by the paired free, skipping the free leaks exactly the buffer, empty returns allocate nothing, borrowed arguments are not copied |
| `knext-ffi/tests/ui.rs` | `trybuild` compile-fail case per rejected type, each message naming the type and the table |
| `knext-ffi/tests/panic_abort.rs` | the same fixture crate compiles with the default profile and fails with knext-ffi's message under `panic = "abort"` |
| `harness/ffi-harness.ts` | from Bun: one manifest record per `#[export]`/`#[record]` in a stripped LTO build, symbols and `_schema` values match what the generator computes, round-trips, panic survival, RSS-bounded leak check that also proves it can see a leak |
