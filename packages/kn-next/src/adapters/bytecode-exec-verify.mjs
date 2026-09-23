/**
 * Prove that a `bun build --compile` executable carries BYTECODE for the entry
 * knext compiled into it — not merely that a binary exists.
 *
 * Why this is a byte scan and not a flag check: dropping `bytecode: true` from a
 * compile still produces a binary that boots and serves, just a slower one. That
 * is the regression nobody notices, so the artifact itself is inspected.
 *
 * What a bytecode compile leaves behind (measured on Bun 1.4.2): the embedded
 * module source is stamped with the pragma `// @bun @bytecode @bun-cjs`
 * (`// @bun @bun-cjs` without the flag), and every string literal of the module
 * appears a SECOND time, inside the compiled bytecode's constant pool — which
 * Bun may lay out before or after the source. knext emits a unique marker
 * literal as the module's banner, so both halves are checked against the module
 * knext compiled rather than against the Bun runtime's own copy of the pragma
 * text:
 *
 *   1. SOURCE: exactly one occurrence of the marker sits directly under a
 *      `// @bun` pragma (within PRAGMA_WINDOW bytes), and that pragma carries
 *      `@bytecode`;
 *   2. BYTECODE: the marker occurs at least once more, elsewhere — the
 *      constant pool of the compiled bytecode.
 *
 * Either half failing is a non-bytecode artifact. Dependency-free on purpose: it
 * is bundled into the compile script and imported by the CLI and its tests.
 */

/** The pragma prefix Bun stamps on every module it bundles for `--compile`. */
const PRAGMA = "// @bun";

/**
 * How far above the marker the module pragma may sit. The marker is the
 * module's banner, so it lands a few hundred bytes under the pragma (after the
 * CommonJS wrapper header). The window keeps an unrelated `// @bun` string
 * elsewhere in the binary from being read as the entry's pragma.
 */
const PRAGMA_WINDOW = 4096;

/**
 * @param {Uint8Array} bytes the compiled executable
 * @param {string} marker the unique literal emitted as the compiled entry's banner
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyBytecodeExec(bytes, marker) {
    if (typeof marker !== "string" || marker.length < 16) {
        return { ok: false, reason: "marker must be a unique string of >= 16 chars" };
    }
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hits = [];
    for (let i = buf.indexOf(marker, 0, "latin1"); i >= 0; i = buf.indexOf(marker, i + marker.length, "latin1")) {
        hits.push(i);
    }
    if (hits.length === 0) {
        return {
            ok: false,
            reason: "the knext entry marker is not in the executable — this is not the entry knext compiled",
        };
    }
    const sources = hits
        .map((at) => ({ at, pragmaAt: buf.lastIndexOf(PRAGMA, at, "latin1") }))
        .filter(({ at, pragmaAt }) => pragmaAt >= 0 && at - pragmaAt <= PRAGMA_WINDOW);
    if (sources.length !== 1) {
        return {
            ok: false,
            reason: `expected exactly one marker directly under a \`// @bun\` module pragma, found ${sources.length} — not the head of a bun --compile module`,
        };
    }
    const { pragmaAt } = sources[0];
    const eol = buf.indexOf(10, pragmaAt);
    const pragmaLine = buf.subarray(pragmaAt, eol < 0 ? pragmaAt + 64 : eol).toString("latin1");
    if (!pragmaLine.includes("@bytecode")) {
        return {
            ok: false,
            reason: `the entry module's pragma is '${pragmaLine}' (no @bytecode) — compiled WITHOUT --bytecode`,
        };
    }
    if (hits.length < 2) {
        return {
            ok: false,
            reason: "the entry marker appears only in the module source — no bytecode constant pool carries it, so the entry was compiled WITHOUT --bytecode",
        };
    }
    return { ok: true };
}
