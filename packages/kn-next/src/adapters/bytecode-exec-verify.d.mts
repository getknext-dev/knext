// Declarations for bytecode-exec-verify.mjs (kept as dependency-free .mjs so the
// bun-run compile script bundles it; this .d.mts exists because TS consumers —
// the CLI build step and the tests — import it with implicit-any off).

/**
 * Does a `bun build --compile` executable carry bytecode for the entry whose
 * banner is `marker`? Fails closed with a reason naming the missing half.
 */
export declare function verifyBytecodeExec(
    bytes: Uint8Array,
    marker: string,
): { ok: true } | { ok: false; reason: string };
