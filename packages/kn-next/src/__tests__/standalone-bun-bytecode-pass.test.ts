/**
 * standalone-bun-bytecode.ts — precompileBunBytecode orchestration, driven with
 * an INJECTED fake `bun` binary (the module's `bunBin` seam) so the whole pass
 * is exercised WITHOUT a real Bun install. This is the environment-independent
 * counterpart to cli-build-bun-bytecode.test.ts (whose `it.skipIf(!bunAvailable)`
 * cases skip in CI's Node-only Lint&Test job), so the pass's logic — walk /
 * per-file transform / .jsc emit / entry guard / fail-open skip / probe-disable —
 * is covered in CI, not only on a machine that has Bun.
 *
 * The fake bun mimics `bun build <file> --bytecode ... --outdir <dir>`: it writes
 * `<dir>/<base>` + `<dir>/<base>.jsc`, exits non-zero for a FAIL_BYTECODE marker,
 * and (as a separate "old bun" double) can fail the capability probe.
 */

import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { precompileBunBytecode } from "../adapters/standalone-bun-bytecode";

let root: string;
let fakeBun: string;

/** A node-script stand-in for `bun build ... --bytecode --outdir <out>`. */
const FAKE_BUN_OK = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const a = process.argv.slice(2); // [build, <file>, ...flags, --outdir, <dir>]
const file = a[1];
const outDir = a[a.indexOf("--outdir") + 1];
const src = fs.readFileSync(file, "utf8");
if (src.includes("FAIL_BYTECODE")) {
  process.stderr.write("bun build: synthetic failure\\n");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const base = path.basename(file);
fs.writeFileSync(path.join(outDir, base), "// @bun @bytecode @bun-cjs\\n" + src);
fs.writeFileSync(path.join(outDir, base + ".jsc"), Buffer.from([1, 2, 3, 4]));
process.exit(0);
`;

/** A stand-in that always fails — models an old Bun without --bytecode emit. */
const FAKE_BUN_OLD = `#!/usr/bin/env node
process.stderr.write("error: unknown flag --bytecode\\n");
process.exit(1);
`;

function writeFakeBun(body: string): string {
    const p = join(root, `bun-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knext-bcpass-"));
    fakeBun = writeFakeBun(FAKE_BUN_OK);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** Build a standalone-like tree; returns its dir. */
function seedTree(): string {
    const dir = join(root, "standalone");
    mkdirSync(dir, { recursive: true });
    // a transformable server-side chunk
    writeFileSync(join(dir, "chunk.js"), "module.exports = () => 1;\n");
    // a nested chunk
    mkdirSync(join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, "server", "route.js"), "module.exports = 2;\n");
    // a standalone ENTRY: server.js beside a .next dir
    mkdirSync(join(dir, ".next"), { recursive: true });
    writeFileSync(join(dir, "server.js"), "require('./chunk.js');\n");
    // a static asset under .next/static — must NEVER be transformed
    mkdirSync(join(dir, ".next", "static"), { recursive: true });
    writeFileSync(join(dir, ".next", "static", "app.js"), "self.x = 1;\n");
    return dir;
}

describe("precompileBunBytecode (injected fake bun)", () => {
    it("transforms server-side .js, emits .jsc, guards the entry, and skips static/entry files", () => {
        const dir = seedTree();

        const res = precompileBunBytecode({
            standaloneDir: dir,
            bunBin: fakeBun,
        });

        // chunk.js + server/route.js transformed (2), the entry is NOT counted.
        expect(res.compiled).toBe(2);
        expect(res.disabled).toBeUndefined();
        expect(existsSync(join(dir, "chunk.js.jsc"))).toBe(true);
        expect(existsSync(join(dir, "server", "route.js.jsc"))).toBe(true);
        // transformed files carry the fake pragma; the entry does NOT.
        expect(readFileSync(join(dir, "chunk.js"), "utf8")).toContain("@bun");

        // the entry got the fail-fast Node guard prepended (compiled > 0).
        expect(res.guarded).toContain(join(dir, "server.js"));
        expect(readFileSync(join(dir, "server.js"), "utf8")).toContain(
            "knext: bun-only build guard",
        );

        // static asset untouched (no .jsc, no pragma).
        expect(existsSync(join(dir, ".next", "static", "app.js.jsc"))).toBe(
            false,
        );
        expect(
            readFileSync(join(dir, ".next", "static", "app.js"), "utf8"),
        ).not.toContain("@bun");
    });

    it("is fail-open: a per-file build failure is recorded in skipped, others still transform", () => {
        const dir = seedTree();
        // This file trips the fake bun's synthetic failure.
        writeFileSync(
            join(dir, "bad.js"),
            "// FAIL_BYTECODE\nmodule.exports=0;\n",
        );

        const res = precompileBunBytecode({
            standaloneDir: dir,
            bunBin: fakeBun,
        });

        expect(res.compiled).toBe(2); // chunk + route still succeed
        expect(res.skipped.some((s) => s.includes("bad.js"))).toBe(true);
        // the failed file is left byte-identical (no .jsc, no pragma).
        expect(existsSync(join(dir, "bad.js.jsc"))).toBe(false);
    });

    it("skips symlinked files (never writes through a link)", () => {
        const dir = seedTree();
        // A symlink to a real js file elsewhere — must be skipped entirely.
        const target = join(root, "linked-target.js");
        writeFileSync(target, "module.exports = 9;\n");
        symlinkSync(target, join(dir, "linked.js"));

        const res = precompileBunBytecode({
            standaloneDir: dir,
            bunBin: fakeBun,
        });

        expect(existsSync(join(dir, "linked.js.jsc"))).toBe(false);
        // the link target is untouched (not transformed through the link).
        expect(readFileSync(target, "utf8")).not.toContain("@bun");
        expect(res.compiled).toBe(2);
    });

    it("guardEntry is idempotent: a second pass does not re-guard the entry", () => {
        const dir = seedTree();
        precompileBunBytecode({ standaloneDir: dir, bunBin: fakeBun });
        const res2 = precompileBunBytecode({
            standaloneDir: dir,
            bunBin: fakeBun,
        });
        // entry already carries the marker → not re-added.
        expect(res2.guarded).toEqual([]);
    });

    it("disables the whole pass when the standalone dir is missing", () => {
        const res = precompileBunBytecode({
            standaloneDir: join(root, "does-not-exist"),
            bunBin: fakeBun,
        });
        expect(res.disabled).toMatch(/standalone dir not found/);
        expect(res.compiled).toBe(0);
    });

    it("disables the pass when the capability probe fails (old/absent bun)", () => {
        const dir = seedTree();
        const oldBun = writeFakeBun(FAKE_BUN_OLD);
        const res = precompileBunBytecode({
            standaloneDir: dir,
            bunBin: oldBun,
        });
        expect(res.disabled).toMatch(/bun bytecode emission unavailable/);
        expect(res.compiled).toBe(0);
        // no transform happened.
        expect(existsSync(join(dir, "chunk.js.jsc"))).toBe(false);
    });

    it("disables the pass when the bun binary is absent (spawn error)", () => {
        const dir = seedTree();
        const res = precompileBunBytecode({
            standaloneDir: dir,
            bunBin: join(root, "no-such-bun"),
        });
        expect(res.disabled).toMatch(/unavailable/);
        expect(res.compiled).toBe(0);
    });

    it("does not guard entries when nothing was compiled", () => {
        // A tree with ONLY an entry + static asset → compiled stays 0, so the
        // entry guard block is never entered.
        const dir = join(root, "entry-only");
        mkdirSync(join(dir, ".next", "static"), { recursive: true });
        writeFileSync(join(dir, "server.js"), "require('next');\n");
        writeFileSync(join(dir, ".next", "static", "a.js"), "x=1;\n");

        const res = precompileBunBytecode({
            standaloneDir: dir,
            bunBin: fakeBun,
        });
        expect(res.compiled).toBe(0);
        expect(res.guarded).toEqual([]);
        expect(readFileSync(join(dir, "server.js"), "utf8")).not.toContain(
            "knext: bun-only build guard",
        );
    });
});
