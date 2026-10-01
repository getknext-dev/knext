/**
 * `resolveRequireLike` — resolving a specifier the way disk-loaded CJS route
 * chunks actually require it (`computeDiskClosure` in `standalone-compile.mjs`).
 *
 * `Bun.resolveSync(spec, dir)` takes an undocumented third `isESM` argument
 * that picks which `package.json#exports` condition set to probe, and
 * nothing in `bun-types` 1.4.2 (the repo's pinned Bun) documents it — a Bun
 * change to that default would only show up ~25 minutes later, as a bytecode
 * error in the docker e2e. This test pins the behaviour directly against a
 * real on-disk fixture package with both a `require`-only and an ESM-only
 * export condition, under the pinned Bun.
 */

import { describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveRequireLike } from "../adapters/standalone-exec-entry.mjs";

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

/**
 * A `node_modules` directory holding:
 *   - `dual-condition-pkg`: a `require` condition AND an ESM/`default`
 *     condition, each pointing at a DIFFERENT file — so picking the wrong one
 *     is observable.
 *   - `esm-only-pkg`: no `require` condition at all (pure ESM), so the
 *     `require` attempt must fail and the ESM fallback must still resolve it.
 */
function fixtureDir(): { dir: string; cleanup: () => void } {
    const dir = realpathSync(
        mkdtempSync(join(tmpdir(), "knext-resolve-require-like-")),
    );
    write(
        join(dir, "node_modules/dual-condition-pkg/package.json"),
        JSON.stringify({
            name: "dual-condition-pkg",
            exports: {
                ".": {
                    require: "./require-target.cjs",
                    default: "./esm-target.mjs",
                },
            },
        }),
    );
    write(
        join(dir, "node_modules/dual-condition-pkg/require-target.cjs"),
        "module.exports = 'require-target';",
    );
    write(
        join(dir, "node_modules/dual-condition-pkg/esm-target.mjs"),
        "export default 'esm-target';",
    );
    write(
        join(dir, "node_modules/esm-only-pkg/package.json"),
        JSON.stringify({
            name: "esm-only-pkg",
            exports: {
                ".": {
                    import: "./esm-only.mjs",
                    default: "./esm-only.mjs",
                },
            },
        }),
    );
    write(
        join(dir, "node_modules/esm-only-pkg/esm-only.mjs"),
        "export default 'esm-only';",
    );
    return {
        dir,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

describe("resolveRequireLike", () => {
    it("picks the require-condition file when the package ships one", () => {
        const { dir, cleanup } = fixtureDir();
        try {
            const resolved = resolveRequireLike("dual-condition-pkg", dir);
            expect(resolved).toBe(
                join(dir, "node_modules/dual-condition-pkg/require-target.cjs"),
            );
        } finally {
            cleanup();
        }
    });

    it("falls back to the ESM/default condition when there is no require condition", () => {
        const { dir, cleanup } = fixtureDir();
        try {
            const resolved = resolveRequireLike("esm-only-pkg", dir);
            expect(resolved).toBe(
                join(dir, "node_modules/esm-only-pkg/esm-only.mjs"),
            );
        } finally {
            cleanup();
        }
    });

    it("throws, naming both attempts, when the specifier resolves under neither condition", () => {
        const { dir, cleanup } = fixtureDir();
        try {
            expect(() =>
                resolveRequireLike("nonexistent-pkg-xyz", dir),
            ).toThrow(
                /require condition failed.*ESM\/default condition failed/s,
            );
        } finally {
            cleanup();
        }
    });
});
