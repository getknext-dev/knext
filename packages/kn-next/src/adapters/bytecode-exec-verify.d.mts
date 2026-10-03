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

/** The unique literal a self-contained build heads route chunk `n` with. */
export declare function routeMarker(marker: string, n: number): string;

/**
 * The `compile.include` proof: the banner heads at least `minModules` modules
 * (the entry and every included module), each under a `@bytecode` pragma.
 */
export declare function verifyBytecodeModules(
    bytes: Uint8Array,
    marker: string,
    minModules: number,
): { ok: true } | { ok: false; reason: string };

/**
 * The self-contained proof: every module the build's banner heads carries
 * bytecode, and route chunks `0 .. routeCount-1` each do by their own marker.
 */
export declare function verifyBytecodeEmbedded(
    bytes: Uint8Array,
    marker: string,
    routeCount: number,
): { ok: true } | { ok: false; reason: string };
