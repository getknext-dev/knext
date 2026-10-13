/**
 * `knext doctor` -- 'use cache' per-process warning (1.x interim, #2277).
 *
 * On the 1.x line nothing backs Next's `'use cache'` with a shared store: an
 * entry lives in one server process's memory (one per pod), is not shared
 * across pods and is lost on scale-to-zero -- and under the scaffold's
 * `cacheMaxMemorySize: 0` it keeps nothing at all, so the directive is
 * effectively a no-op. Doctor detects the DIRECTIVE in the app's source (not
 * the cacheComponents flag, which many apps enable without writing 'use
 * cache') and says which of the two cases applies. WARN only, never a failure;
 * no row at all for an app that does not use the directive.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KubectlFn, type ProbeOutcome, runDoctor } from "../cli/doctor";
import {
    DEFAULT_SCAN_LIMITS,
    hasUseCacheDirective,
    scanUseCache,
    setsZeroCacheMemory,
    stripCodeComments,
    type UseCacheScan,
} from "../cli/doctor/checks/use-cache";

const noKubectl: KubectlFn = () => ({
    ok: false,
    stdout: "",
    stderr: "no stub",
});
const okProbe = async (): Promise<ProbeOutcome> => "ok";

const scanOf = (file: string | undefined, truncated = false): UseCacheScan => ({
    file,
    truncated,
});

const run = (nextConfig: string | undefined, scan: UseCacheScan) =>
    runDoctor({
        kubectl: noKubectl,
        probeImage: okProbe,
        readNextConfigFile: () => nextConfig,
        scanUseCache: () => scan,
    });

const row = async (cfg: string | undefined, scan: UseCacheScan) =>
    (await run(cfg, scan)).checks.find((c) => c.id === "use-cache");

/** Plain language: no stack frames, no error class names. */
function expectNoStackTrace(text: string | undefined): void {
    expect(text).toBeTruthy();
    expect(text).not.toMatch(/\n\s*at\s/);
    expect(text).not.toMatch(/\b\w*Error\b/);
    expect(text).not.toMatch(/#\d+/);
}

describe("doctor use-cache check: detection", () => {
    it("warns (per-process) when the source uses 'use cache'", async () => {
        const r = await row(
            "export default { output: 'standalone' };",
            scanOf("app/page.tsx"),
        );
        expect(r?.status).toBe("warn");
        expect(r?.detail).toContain("app/page.tsx");
        expect(r?.detail).toMatch(/per-process/);
        expect(r?.detail).toMatch(/not shared across pods/);
        expect(r?.detail).toMatch(/scale-to-zero/);
        expect(r?.detail).not.toMatch(/no-op/);
        expectNoStackTrace(r?.detail);
        expectNoStackTrace(r?.hint);
    });

    it("emits no row when the source does not use 'use cache', even with cacheComponents on", async () => {
        for (const cfg of [
            "export default { cacheComponents: true };",
            "export default { cacheComponents: true, cacheMaxMemorySize: 0 };",
            "export default {};",
        ]) {
            expect(await row(cfg, scanOf(undefined))).toBeUndefined();
        }
    });

    it("emits no row outside a Next app (no next.config)", async () => {
        expect(await row(undefined, scanOf("app/page.tsx"))).toBeUndefined();
        expect(await row(undefined, scanOf(undefined, true))).toBeUndefined();
    });

    it("warns that the scan was incomplete when it hit the cap without a hit", async () => {
        const r = await row("export default {};", scanOf(undefined, true));
        expect(r?.status).toBe("warn");
        expect(r?.detail).toMatch(/stopped early|incomplete/);
        expect(r?.hint).toMatch(/next\.config/);
        expectNoStackTrace(r?.detail);
        expectNoStackTrace(r?.hint);
    });

    it("a hit wins over truncation", async () => {
        const r = await row("export default {};", scanOf("app/page.tsx", true));
        expect(r?.detail).toMatch(/per-process/);
    });

    it("is a warning, not a failure: it never changes the exit code", async () => {
        for (const cfg of [
            "export default {};",
            "export default { cacheMaxMemorySize: 0 };",
        ]) {
            const none = await run(cfg, scanOf(undefined));
            for (const s of [scanOf("app/page.tsx"), scanOf(undefined, true)]) {
                expect((await run(cfg, s)).exitCode).toBe(none.exitCode);
            }
        }
    });
});

describe("doctor use-cache check: cacheMaxMemorySize: 0 variant", () => {
    it("says the directive is a no-op under the scaffold's cacheMaxMemorySize: 0", async () => {
        const r = await row(
            "export default {\n  output: 'standalone',\n  cacheMaxMemorySize: 0,\n};",
            scanOf("src/lib/data.ts"),
        );
        expect(r?.status).toBe("warn");
        expect(r?.detail).toContain("src/lib/data.ts");
        expect(r?.detail).toMatch(/no-op/);
        expect(r?.detail).toContain("cacheMaxMemorySize: 0");
        expect(r?.detail).not.toMatch(/per-process/);
        expect(r?.hint).toMatch(/cacheMaxMemorySize/);
        expectNoStackTrace(r?.detail);
        expectNoStackTrace(r?.hint);
    });

    it("falls back to the per-process wording when the limit is not zero or is commented out", async () => {
        for (const cfg of [
            "export default { cacheMaxMemorySize: 50 * 1024 * 1024 };",
            "export default { cacheMaxMemorySize: 0.5e9 };",
            "export default {\n  // cacheMaxMemorySize: 0,\n};",
            "export default { /* cacheMaxMemorySize: 0 */ };",
        ]) {
            const r = await row(cfg, scanOf("app/page.tsx"));
            expect(r?.detail).toMatch(/per-process/);
            expect(r?.detail).not.toMatch(/no-op/);
        }
    });

    it("a glob string before the key does not hide cacheMaxMemorySize: 0", () => {
        const cfg =
            "export default {\n  images: { remotePatterns: [{ pathname: '/img/**' }] },\n  cacheMaxMemorySize: 0,\n  /** docs */\n};";
        expect(setsZeroCacheMemory(cfg)).toBe(true);
    });

    it("setsZeroCacheMemory reads the config text, quoted keys included", () => {
        expect(setsZeroCacheMemory("{ cacheMaxMemorySize: 0 }")).toBe(true);
        expect(setsZeroCacheMemory("{ cacheMaxMemorySize:0, x: 1 }")).toBe(
            true,
        );
        expect(setsZeroCacheMemory('{ "cacheMaxMemorySize": 0 }')).toBe(true);
        expect(setsZeroCacheMemory("{ 'cacheMaxMemorySize': 0 }")).toBe(true);
        expect(setsZeroCacheMemory("{ cacheMaxMemorySize: 10 }")).toBe(false);
        expect(setsZeroCacheMemory("{ cacheMaxMemorySize: 0x10 }")).toBe(false);
        expect(setsZeroCacheMemory("{ xcacheMaxMemorySize: 0 }")).toBe(false);
        expect(setsZeroCacheMemory("{}")).toBe(false);
    });
});

describe("hasUseCacheDirective", () => {
    it("matches the directive at file top, in a function body, and its variants", () => {
        for (const src of [
            "'use cache';\nexport default async function P() {}",
            '"use cache"\nexport async function f() {}',
            "export async function f() {\n  'use cache';\n  return 1;\n}",
            'export async function f() {\n\t"use cache: remote";\n}',
            "async function g() {\n  'use cache: private'\n}",
        ]) {
            expect(hasUseCacheDirective(src)).toBe(true);
        }
    });

    it("strips a leading BOM", () => {
        expect(hasUseCacheDirective("﻿'use cache';\nexport default 1;")).toBe(
            true,
        );
    });

    it("matches the one-line function-body form right after {", () => {
        for (const src of [
            "export async function f() { 'use cache'; return 1; }",
            'const f = async () => {"use cache"; return 1 }',
            "async function g() { 'use cache' }",
            "/** docs */ async function g() { /* c */ 'use cache'; }",
        ]) {
            expect(hasUseCacheDirective(src)).toBe(true);
        }
    });

    it("does not let a '/*' inside a string eat the code after it", () => {
        const src =
            "const route = '/api/*';\nexport async function f() {\n  'use cache';\n  return route; // done */\n}";
        expect(hasUseCacheDirective(src)).toBe(true);
    });

    it("ignores comments, ordinary strings, object keys and other directives", () => {
        for (const src of [
            "// 'use cache';\nexport default 1;",
            "/*\n 'use cache';\n*/\nexport default 1;",
            "const s = 'use cache';",
            "const o = { 'use cache': 1 };",
            "f('use cache' + x);",
            "'use client';\nexport default 1;",
            "'use server';",
            "'use caches';",
            "",
        ]) {
            expect(hasUseCacheDirective(src)).toBe(false);
        }
    });

    it("accepted false positives (warn-only): a directive-shaped line in a template literal or call argument", () => {
        // Documented in use-cache.ts: the detector is line-based, not a parser.
        expect(hasUseCacheDirective("const t = `\n'use cache'\n`;")).toBe(true);
        expect(hasUseCacheDirective("f(\n  'use cache'\n);")).toBe(true);
    });
});

describe("stripCodeComments", () => {
    it("keeps string contents and removes comments outside strings", () => {
        expect(stripCodeComments("a('/*'); /* x */ b(); // y")).toBe(
            "a('/*');  b(); ",
        );
        expect(stripCodeComments("u = 'http://x'; // c")).toBe(
            "u = 'http://x'; ",
        );
        expect(stripCodeComments('s = "a\\"//b";')).toBe('s = "a\\"//b";');
        expect(stripCodeComments("t = `/* // x */`;")).toBe(
            "t = `/* // x */`;",
        );
        expect(stripCodeComments("/*\n\n*/x")).toBe("\n\nx");
        expect(stripCodeComments("x /* unterminated")).toBe("x ");
    });
});

describe("scanUseCache (default source scanner)", () => {
    const root = mkdtempSync(join(tmpdir(), "knext-use-cache-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const put = (base: string, rel: string, body: string) => {
        const full = join(base, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, body);
    };
    const DIRECTIVE = "export async function d() {\n  'use cache';\n}";
    let n = 0;
    const fresh = () => {
        const dir = join(root, `case-${n++}`);
        mkdirSync(dir);
        return dir;
    };

    it("reports no file for an app without the directive", () => {
        const app = fresh();
        put(
            app,
            "app/page.tsx",
            "export default function P() { return null; }",
        );
        put(app, "app/layout.tsx", "'use client';\nexport default 1;");
        expect(scanUseCache(app)).toEqual({
            file: undefined,
            truncated: false,
        });
    });

    it("ignores node_modules at any depth, dot-dirs and non-source files", () => {
        const app = fresh();
        put(app, "node_modules/lib/index.js", "'use cache';\n");
        put(app, "packages/x/node_modules/lib/index.js", "'use cache';\n");
        put(app, ".next/server/app/page.js", "'use cache';\n");
        put(app, "app/notes.md", "'use cache';\n");
        expect(scanUseCache(app).file).toBeUndefined();
    });

    it("skips out/dist/build/coverage only at the app root", () => {
        const app = fresh();
        for (const d of ["out", "dist", "build", "coverage"]) {
            put(app, `${d}/x.js`, "'use cache';\n");
        }
        expect(scanUseCache(app).file).toBeUndefined();
        put(app, "app/build/page.tsx", DIRECTIVE);
        expect(scanUseCache(app).file).toBe(join("app", "build", "page.tsx"));
    });

    it("finds the directive in app source and returns a relative path", () => {
        const app = fresh();
        put(app, "src/lib/data.ts", DIRECTIVE);
        expect(scanUseCache(app)).toEqual({
            file: join("src", "lib", "data.ts"),
            truncated: false,
        });
    });

    it("does not follow symlinks", () => {
        const app = fresh();
        const outside = fresh();
        put(outside, "data.ts", DIRECTIVE);
        symlinkSync(outside, join(app, "linked"));
        expect(scanUseCache(app)).toEqual({
            file: undefined,
            truncated: false,
        });
    });

    it("finishes fast on a symlink loop", () => {
        const app = fresh();
        symlinkSync(".", join(app, "l0"));
        symlinkSync(".", join(app, "l1"));
        const t0 = Date.now();
        expect(scanUseCache(app)).toEqual({
            file: undefined,
            truncated: false,
        });
        expect(Date.now() - t0).toBeLessThan(1000);
    }, 5000);

    it("stops at the cap and says it was truncated (source files and directories count)", () => {
        const app = fresh();
        for (let i = 0; i < 10; i++) put(app, `lib/f-${i}.ts`, "export {};");
        put(app, "src/z.ts", DIRECTIVE);
        expect(
            scanUseCache(app, { ...DEFAULT_SCAN_LIMITS, maxEntries: 5 }),
        ).toEqual({
            file: undefined,
            truncated: true,
        });
        expect(scanUseCache(app).file).toBe(join("src", "z.ts"));
    });

    it("non-source files do not use up the cap", () => {
        const app = fresh();
        for (let i = 0; i < 10; i++) put(app, `src/assets/img-${i}.png`, "x");
        put(app, "src/z.ts", DIRECTIVE);
        expect(
            scanUseCache(app, { ...DEFAULT_SCAN_LIMITS, maxEntries: 5 }),
        ).toEqual({ file: join("src", "z.ts"), truncated: false });
    });

    it("skips public/ at the root: a huge asset folder gives no row", async () => {
        const app = fresh();
        put(
            app,
            "app/page.tsx",
            "export default function P() { return null; }",
        );
        const n = DEFAULT_SCAN_LIMITS.maxEntries + 500;
        mkdirSync(join(app, "public"));
        for (let i = 0; i < n; i++) {
            writeFileSync(join(app, "public", `img-${i}.ts`), "");
        }
        expect(scanUseCache(app)).toEqual({
            file: undefined,
            truncated: false,
        });
        const report = await runDoctor({
            kubectl: noKubectl,
            probeImage: okProbe,
            readNextConfigFile: () => "export default {};",
            scanUseCache: () => scanUseCache(app),
        });
        expect(report.checks.some((c) => c.id === "use-cache")).toBe(false);
        put(app, "app/public/page.tsx", DIRECTIVE);
        expect(scanUseCache(app).file).toBe(join("app", "public", "page.tsx"));
    }, 30000);

    it("skips a source file over the size limit", () => {
        const app = fresh();
        put(app, "src/big.ts", `${DIRECTIVE}\n${"// pad\n".repeat(100)}`);
        expect(
            scanUseCache(app, { ...DEFAULT_SCAN_LIMITS, maxFileBytes: 64 })
                .file,
        ).toBeUndefined();
        expect(scanUseCache(app).file).toBe(join("src", "big.ts"));
    });
});
