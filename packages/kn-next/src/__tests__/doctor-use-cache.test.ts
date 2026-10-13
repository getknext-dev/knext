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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KubectlFn, type ProbeOutcome, runDoctor } from "../cli/doctor";
import {
    findUseCacheFile,
    hasUseCacheDirective,
    setsZeroCacheMemory,
} from "../cli/doctor/checks/use-cache";

const noKubectl: KubectlFn = () => ({
    ok: false,
    stdout: "",
    stderr: "no stub",
});
const okProbe = async (): Promise<ProbeOutcome> => "ok";

const run = (
    nextConfig: string | undefined,
    useCacheFile: string | undefined,
) =>
    runDoctor({
        kubectl: noKubectl,
        probeImage: okProbe,
        readNextConfigFile: () => nextConfig,
        findUseCacheFile: () => useCacheFile,
    });

const row = async (cfg: string | undefined, file: string | undefined) =>
    (await run(cfg, file)).checks.find((c) => c.id === "use-cache");

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
            "app/page.tsx",
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
            expect(await row(cfg, undefined)).toBeUndefined();
        }
    });

    it("emits no row outside a Next app (no next.config)", async () => {
        expect(await row(undefined, "app/page.tsx")).toBeUndefined();
    });

    it("is a warning, not a failure: it never changes the exit code", async () => {
        for (const cfg of [
            "export default {};",
            "export default { cacheMaxMemorySize: 0 };",
        ]) {
            const withIt = await run(cfg, "app/page.tsx");
            const without = await run(cfg, undefined);
            expect(withIt.exitCode).toBe(without.exitCode);
        }
    });
});

describe("doctor use-cache check: cacheMaxMemorySize: 0 variant", () => {
    it("says the directive is a no-op under the scaffold's cacheMaxMemorySize: 0", async () => {
        const r = await row(
            "export default {\n  output: 'standalone',\n  cacheMaxMemorySize: 0,\n};",
            "src/lib/data.ts",
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
            const r = await row(cfg, "app/page.tsx");
            expect(r?.detail).toMatch(/per-process/);
            expect(r?.detail).not.toMatch(/no-op/);
        }
    });

    it("setsZeroCacheMemory reads the config text", () => {
        expect(setsZeroCacheMemory("{ cacheMaxMemorySize: 0 }")).toBe(true);
        expect(setsZeroCacheMemory("{ cacheMaxMemorySize:0, x: 1 }")).toBe(
            true,
        );
        expect(setsZeroCacheMemory("{ cacheMaxMemorySize: 10 }")).toBe(false);
        expect(setsZeroCacheMemory("{ cacheMaxMemorySize: 0x10 }")).toBe(false);
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

    it("ignores comments, ordinary strings and other directives", () => {
        for (const src of [
            "// 'use cache';\nexport default 1;",
            "/*\n 'use cache';\n*/\nexport default 1;",
            "const s = 'use cache';",
            "'use client';\nexport default 1;",
            "'use server';",
            "'use caches';",
            "",
        ]) {
            expect(hasUseCacheDirective(src)).toBe(false);
        }
    });
});

describe("findUseCacheFile (default source scanner)", () => {
    const root = mkdtempSync(join(tmpdir(), "knext-use-cache-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const put = (rel: string, body: string) => {
        const full = join(root, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, body);
    };

    it("returns undefined for an app without the directive", () => {
        put("app/page.tsx", "export default function P() { return null; }");
        put("app/layout.tsx", "'use client';\nexport default 1;");
        expect(findUseCacheFile(root)).toBeUndefined();
    });

    it("ignores node_modules and build output", () => {
        put("node_modules/lib/index.js", "'use cache';\n");
        put(".next/server/app/page.js", "'use cache';\n");
        put("app/notes.md", "'use cache';\n");
        expect(findUseCacheFile(root)).toBeUndefined();
    });

    it("finds the directive in app source and returns a relative path", () => {
        put(
            "src/lib/data.ts",
            "export async function d() {\n  'use cache';\n}",
        );
        expect(findUseCacheFile(root)).toBe(join("src", "lib", "data.ts"));
    });
});
