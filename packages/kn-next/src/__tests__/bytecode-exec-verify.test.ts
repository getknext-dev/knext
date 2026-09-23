/**
 * `verifyBytecodeExec` — the fail-closed proof that a compiled standalone
 * executable actually carries bytecode.
 *
 * The two halves are tested against REAL `Bun.build({ compile })` output, not
 * only hand-made buffers: the layout (pragma text, where the constant pool
 * lands relative to the source) is Bun's, and a verifier tested only against
 * its author's model of that layout proves nothing about the binary. Both
 * directions: a bytecode compile must pass, the SAME entry compiled without
 * bytecode must fail.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBytecodeExec } from "../adapters/bytecode-exec-verify.mjs";

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const MARKER = "knext-standalone-exec:feedfacecafebeef00112233";

async function compile(bytecode: boolean, nonLatin1 = false): Promise<Buffer> {
    const dir = mkdtempSync(join(tmpdir(), "knext-bytecode-verify-"));
    tempDirs.push(dir);
    const entry = join(dir, "entry.cjs");
    // A real Next server bundle keeps a LEGAL comment (`/*! … */`, a license
    // notice) holding a non-Latin-1 character — measured: `s’adagia`, U+2019,
    // in a vendored package's notice. Whether Bun then stores the module SOURCE
    // as UTF-16LE is version-dependent (see the layout block below).
    writeFileSync(
        entry,
        nonLatin1
            ? '/*! batte col remo qualunque s’adagia */\nconsole.log(require("node:path").sep);\n'
            : 'console.log(require("node:path").sep);\n',
    );
    const outfile = join(dir, bytecode ? "with-bytecode" : "without-bytecode");
    const result = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        format: "cjs",
        bytecode,
        minify: true,
        banner: `globalThis.__knextStandaloneExecMarker=${JSON.stringify(MARKER)};`,
        compile: { outfile },
    } as Parameters<typeof Bun.build>[0]);
    expect(result.success).toBe(true);
    return readFileSync(outfile);
}

describe("verifyBytecodeExec — real bun --compile output", () => {
    it("PASSES an executable compiled with bytecode", async () => {
        expect(verifyBytecodeExec(await compile(true), MARKER)).toEqual({
            ok: true,
        });
    }, 60_000);

    it("FAILS the same entry compiled WITHOUT bytecode", async () => {
        const verdict = verifyBytecodeExec(await compile(false), MARKER);
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(
            /WITHOUT --bytecode/,
        );
    }, 60_000);

    it("FAILS an executable that does not carry this build's marker", async () => {
        const verdict = verifyBytecodeExec(
            await compile(true),
            "knext-standalone-exec:000000000000000000000000",
        );
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(
            /marker is not in the executable/,
        );
    }, 60_000);
});

/**
 * Where Bun stores the embedded module SOURCE depends on the Bun VERSION, not
 * only on the input — measured on the same entries (a legal comment holding
 * U+2019, the character a real Next bundle's vendored license notice carries):
 *
 *   - Bun 1.4.0 (the repo pin, and the shipped image): Latin-1, always — no
 *     input tried stored UTF-16 (legal comments, string literals, `u` regexes,
 *     non-ASCII identifiers, `//!` and `@license` comments; and a real npm
 *     Next 16.2.11 app). The marker appears twice in Latin-1.
 *   - Bun 1.4.2: UTF-16LE for this entry and for that real app. The marker
 *     appears once in Latin-1 (the constant pool) and once in UTF-16 (source).
 *
 * The verifier must hold under both, so: the REAL-output tests assert the
 * layout the running Bun actually produced (exactly, for a measured version)
 * and run the verifier both directions on it; the UTF-16 branch is exercised
 * on EVERY Bun by a byte-level fixture of the measured 1.4.2 layout below.
 */
type Layout = "latin1-source" | "utf16-source";

function layoutOf(bytes: Buffer): Layout | "unknown" {
    const latin1 = bytes.toString("latin1").split(MARKER).length - 1;
    const utf16 = bytes.indexOf(Buffer.from(MARKER, "utf16le")) > -1;
    if (latin1 === 2 && !utf16) return "latin1-source";
    if (latin1 === 1 && utf16) return "utf16-source";
    return "unknown";
}

/** The measured layout per Bun version (see above). */
const MEASURED_LAYOUT: Record<string, Layout> = {
    "1.4.0": "latin1-source",
    "1.4.2": "utf16-source",
};

describe("verifyBytecodeExec — real output for an entry like a real Next bundle (legal comment with U+2019)", () => {
    it(`the running Bun (${Bun.version}) stores the source in its measured layout`, async () => {
        const layout = layoutOf(await compile(true, true));
        // Never "unknown": the verifier is only claimed for these two layouts.
        expect(layout).not.toBe("unknown");
        const measured = MEASURED_LAYOUT[Bun.version];
        if (measured) expect(layout).toBe(measured);
    }, 60_000);

    it("PASSES the bytecode build", async () => {
        expect(verifyBytecodeExec(await compile(true, true), MARKER)).toEqual({
            ok: true,
        });
    }, 60_000);

    it("FAILS the same entry compiled WITHOUT bytecode", async () => {
        const verdict = verifyBytecodeExec(await compile(false, true), MARKER);
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(
            /WITHOUT --bytecode/,
        );
    }, 60_000);
});

describe("verifyBytecodeExec — the UTF-16 source layout (byte-level fixture of measured Bun 1.4.2 output), on every Bun", () => {
    // What Bun 1.4.2 lays down for a real Next app: the constant-pool copy of
    // the marker in Latin-1, runtime noise, then the module source in UTF-16LE
    // headed by its pragma and the CommonJS wrapper.
    const utf16Source = (pragma: string) =>
        Buffer.from(
            `// @bun ${pragma}\n(function(exports, require, module, __filename, __dirname) {globalThis.__knextStandaloneExecMarker="${MARKER}";`,
            "utf16le",
        );
    const pool = Buffer.concat([
        Buffer.from("\u0000\u0002\u0000\u0000", "latin1"),
        Buffer.from(MARKER, "latin1"),
        Buffer.from("\u0000\u0000Cannot destructure", "latin1"),
    ]);
    const noise = Buffer.alloc(5000, 0x41);

    it("non-vacuity: a Latin-1-only scan finds NO source here (only the pool copy)", () => {
        const bytes = Buffer.concat([
            pool,
            noise,
            utf16Source("@bytecode @bun-cjs"),
        ]);
        const latin1 = bytes.toString("latin1");
        expect(latin1.split(MARKER).length - 1).toBe(1);
        expect(latin1.includes("// @bun @bytecode")).toBe(false);
    });

    it("PASSES the bytecode layout (pool copy + UTF-16 source under a @bytecode pragma)", () => {
        const bytes = Buffer.concat([
            pool,
            noise,
            utf16Source("@bytecode @bun-cjs"),
        ]);
        expect(verifyBytecodeExec(bytes, MARKER)).toEqual({ ok: true });
    });

    it("FAILS the non-bytecode layout (UTF-16 source under a plain pragma, no pool)", () => {
        const verdict = verifyBytecodeExec(
            Buffer.concat([noise, utf16Source("@bun-cjs")]),
            MARKER,
        );
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(
            /WITHOUT --bytecode/,
        );
    });

    it("FAILS a UTF-16 @bytecode source with no pool copy", () => {
        const verdict = verifyBytecodeExec(
            Buffer.concat([noise, utf16Source("@bytecode @bun-cjs")]),
            MARKER,
        );
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(/constant pool/);
    });
});

describe("verifyBytecodeExec — each half on its own", () => {
    const src = (pragma: string) =>
        `// @bun ${pragma}\n(function(){globalThis.m="${MARKER}";})`;

    it("a bytecode pragma WITHOUT the constant-pool copy fails", () => {
        const verdict = verifyBytecodeExec(
            Buffer.from(src("@bytecode @bun-cjs")),
            MARKER,
        );
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(/constant pool/);
    });

    it("a second copy WITHOUT the bytecode pragma fails", () => {
        const verdict = verifyBytecodeExec(
            Buffer.from(`pool:${MARKER}\n${src("@bun-cjs")}`),
            MARKER,
        );
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(/no @bytecode/);
    });

    it("a marker far from any pragma is not read as the module head", () => {
        const far = `// @bun @bytecode @bun-cjs\n${"x".repeat(10_000)}"${MARKER}" pool:${MARKER}`;
        expect(verifyBytecodeExec(Buffer.from(far), MARKER).ok).toBe(false);
    });

    it("rejects a marker too short to be unique", () => {
        expect(verifyBytecodeExec(Buffer.from("x"), "short").ok).toBe(false);
    });
});
