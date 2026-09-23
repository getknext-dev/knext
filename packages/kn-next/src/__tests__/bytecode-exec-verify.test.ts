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

async function compile(bytecode: boolean): Promise<Buffer> {
    const dir = mkdtempSync(join(tmpdir(), "knext-bytecode-verify-"));
    tempDirs.push(dir);
    const entry = join(dir, "entry.cjs");
    writeFileSync(entry, 'console.log(require("node:path").sep);\n');
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
