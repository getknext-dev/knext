/**
 * Prove that a `bun build --compile` executable carries BYTECODE for the entry
 * knext compiled into it — not merely that a binary exists.
 *
 * Why this is a byte scan and not a flag check: dropping `bytecode: true` from a
 * compile still produces a binary that boots and serves, just a slower one. That
 * is the regression nobody notices, so the artifact itself is inspected.
 *
 * What a compile leaves behind (measured on Bun 1.4.2, darwin-arm64 and
 * linux-x64-musl, on synthetic entries AND real Next apps):
 *
 *   - the embedded module SOURCE, headed by the pragma `// @bun @bytecode
 *     @bun-cjs` with bytecode and `// @bun @bun-cjs` without it. Bun stores
 *     that source Latin-1 when it can, and UTF-16LE when the bundle holds any
 *     non-Latin-1 character — which a real Next server bundle does. A scan that
 *     only reads Latin-1 finds no source at all on a real app (the defect this
 *     module once had);
 *   - with bytecode only: every string literal of the module a SECOND time, in
 *     the compiled bytecode's constant pool (Latin-1, since the marker is
 *     ASCII), laid out before or after the source.
 *
 * knext emits a unique per-build marker literal as the module's banner, so the
 * check is made against the module knext compiled, never against the Bun
 * runtime's own copy of the pragma text:
 *
 *   1. SOURCE: exactly one marker occurrence — in either encoding — sits
 *      directly under a `// @bun` pragma of the SAME encoding (within
 *      PRAGMA_WINDOW characters), and that pragma carries `@bytecode`;
 *   2. BYTECODE: at least one OTHER marker occurrence exists — the constant
 *      pool.
 *
 * A non-bytecode build fails (1) on its pragma and (2) on the missing pool
 * copy; an executable from another build fails on the marker. Dependency-free
 * on purpose: bundled into the compile script and imported by the CLI.
 */

/** The pragma prefix Bun stamps on every module it bundles for `--compile`. */
const PRAGMA = "// @bun";

/**
 * How far above the marker (in characters) the module pragma may sit. The
 * marker is the module's banner, so it lands a few hundred characters under the
 * pragma (after the CommonJS wrapper header). The window keeps an unrelated
 * `// @bun` string elsewhere in the binary from being read as the entry's.
 */
const PRAGMA_WINDOW = 4096;

const ENCODINGS = /** @type {const} */ ([
    ["latin1", 1],
    ["utf16le", 2],
]);

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
    for (const [encoding, width] of ENCODINGS) {
        const needle = Buffer.from(marker, encoding);
        const pragma = Buffer.from(PRAGMA, encoding);
        for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + needle.length)) {
            const pragmaAt = buf.lastIndexOf(pragma, at);
            const isSource = pragmaAt >= 0 && at - pragmaAt <= PRAGMA_WINDOW * width;
            let pragmaLine = "";
            if (isSource) {
                const eol = buf.indexOf(Buffer.from("\n", encoding), pragmaAt);
                const end = eol < 0 ? pragmaAt + 64 * width : eol;
                pragmaLine = buf.subarray(pragmaAt, end).toString(encoding);
            }
            hits.push({ encoding, isSource, pragmaLine });
        }
    }
    if (hits.length === 0) {
        return {
            ok: false,
            reason: "the knext entry marker is not in the executable — this is not the entry knext compiled",
        };
    }
    const sources = hits.filter((h) => h.isSource);
    if (sources.length !== 1) {
        return {
            ok: false,
            reason: `expected exactly one marker directly under a \`// @bun\` module pragma (Latin-1 or UTF-16), found ${sources.length} — not the head of a bun --compile module`,
        };
    }
    if (!sources[0].pragmaLine.includes("@bytecode")) {
        return {
            ok: false,
            reason: `the entry module's pragma is '${sources[0].pragmaLine}' (no @bytecode) — compiled WITHOUT --bytecode`,
        };
    }
    if (hits.length - sources.length < 1) {
        return {
            ok: false,
            reason: "the entry marker appears only in the module source — no bytecode constant pool carries it, so the entry was compiled WITHOUT --bytecode",
        };
    }
    return { ok: true };
}
