---
"@getknext/core": patch
---

In-process Rust (Beta): the module `knext ffi generate` writes now refuses, before Rust is called, every integer argument Bun's `bun:ffi` would silently corrupt, for all of `i8` `i16` `i32` `u8` `u16` `u32` (a fraction, `NaN`, `Infinity`, a value outside the type's range, or a number whose low 32 bits happen to be in range) and `i64` `u64` `isize` `usize` (a `number`, or a `bigint` outside the 64-bit range). The `TypeError` names the function and argument and echoes at most a short number or a bit count, never an arbitrary value. Regenerate your wrapper with `knext ffi generate`; `knext ffi check` reports the committed one as out of date until you do.
