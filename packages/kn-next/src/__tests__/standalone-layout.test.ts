/**
 * The nested-standalone diagnosis: when Next.js infers a workspace root ABOVE
 * the app (a parent lockfile), it writes the standalone server to
 * `.next/standalone/<app>/server.js` instead of `.next/standalone/server.js`.
 *
 * knext must not silently package that layout — the traced files can live
 * outside the app directory — so it fails, but it must name the REAL cause
 * (the inferred root and the lockfile that caused it) and the fix, instead of
 * blaming `output: 'standalone'`, which is set.
 *
 * Both halves are pinned: the normal layout produces no diagnosis, the nested
 * one produces the actionable one.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diagnoseNestedStandalone } from "../cli/standalone-layout";

/** Every throwaway tree made below, drained in one afterAll. */
const tempRoots: string[] = [];
afterAll(() => {
    for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
});

/** A fresh temp base with `files` (relative to it) written. */
function tree(files: Record<string, string>): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "knext-layout-")));
    tempRoots.push(base);
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
    }
    return base;
}

describe("diagnoseNestedStandalone", () => {
    it("normal layout (.next/standalone/server.js) -> no diagnosis", () => {
        const base = tree({
            "package-lock.json": "{}",
            "app/.next/standalone/server.js": "// s\n",
        });
        expect(diagnoseNestedStandalone(join(base, "app"))).toBeNull();
    });

    it("no standalone output at all -> no diagnosis", () => {
        const base = tree({
            "package-lock.json": "{}",
            "app/package.json": "{}",
        });
        expect(diagnoseNestedStandalone(join(base, "app"))).toBeNull();
    });

    it("nested layout under a parent lockfile -> names the root, the lockfile, the nested path and the fix", () => {
        const base = tree({
            "package-lock.json": "{}",
            "app/.next/standalone/app/server.js": "// s\n",
        });
        const msg = diagnoseNestedStandalone(join(base, "app"));
        expect(msg).not.toBeNull();
        expect(msg).toContain(base);
        expect(msg).toContain(join(base, "package-lock.json"));
        expect(msg).toContain(".next/standalone/app/server.js");
        expect(msg).toContain("outputFileTracingRoot");
        expect(msg).toMatch(/remove/i);
        // The misleading advice this replaces must not come back.
        expect(msg).not.toMatch(/check .*output: ?'standalone'/i);
    });

    it("nested layout with NO lockfile found (root pinned some other way) -> still actionable", () => {
        const base = tree({
            "app/.next/standalone/app/server.js": "// s\n",
        });
        const msg = diagnoseNestedStandalone(join(base, "app"));
        expect(msg).not.toBeNull();
        expect(msg).toContain(base);
        expect(msg).toContain("outputFileTracingRoot");
    });

    it("a deeper nest (apps/web two levels below the root) names the outer root", () => {
        const base = tree({
            "pnpm-lock.yaml": "x",
            "apps/web/.next/standalone/apps/web/server.js": "// s\n",
        });
        const msg = diagnoseNestedStandalone(join(base, "apps", "web"));
        expect(msg).toContain(base);
        expect(msg).toContain("pnpm-lock.yaml");
    });
});
