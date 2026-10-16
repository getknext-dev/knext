'use server';

// Server Actions that call the zone's Rust library in-process through the
// generated, server-only wrapper (in-process Rust, Beta, Bun only). The FFI
// e2e (.github/workflows/ffi-e2e.yml) calls each one over HTTP with the
// `Next-Action` header. Each returns a plain result object rather than
// throwing, so the error CLASS the wrapper threw reaches the caller (a thrown
// error's message is redacted in production). None of them changes state.

import {
  checked_greet,
  explode,
  FfiLoadError,
  greet,
  pause,
  RustError,
  RustPanicError,
} from '@/generated/ffi';

export type FfiResult =
  | { ok: true; value: string }
  | {
      ok: false;
      error: 'RustError' | 'RustPanicError' | 'FfiLoadError' | 'Error';
      fn: string | null;
      message: string;
    };

function settle(call: () => string): FfiResult {
  try {
    return { ok: true, value: call() };
  } catch (err) {
    if (err instanceof RustPanicError) {
      return { ok: false, error: 'RustPanicError', fn: err.fn, message: err.message };
    }
    if (err instanceof RustError) {
      return { ok: false, error: 'RustError', fn: err.fn, message: err.message };
    }
    if (err instanceof FfiLoadError) {
      return { ok: false, error: 'FfiLoadError', fn: null, message: err.message };
    }
    return { ok: false, error: 'Error', fn: null, message: String(err) };
  }
}

/** Rust `greet(String) -> String`. */
export async function greetAction(name: string): Promise<FfiResult> {
  return settle(() => greet(name));
}

/** Rust `checked_greet(String) -> Result<String, String>`: an empty name is a `RustError`. */
export async function checkedGreetAction(name: string): Promise<FfiResult> {
  return settle(() => checked_greet(name));
}

/** Rust `explode(String) -> String`: always panics, a `RustPanicError`. */
export async function explodeAction(message: string): Promise<FfiResult> {
  return settle(() => explode(message));
}

/** Rust `pause(u32) -> u32`: blocks for `ms` milliseconds, so the call is counted as slow. */
export async function pauseAction(ms: number): Promise<FfiResult> {
  return settle(() => String(pause(ms)));
}
