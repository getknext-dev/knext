/**
 * #440 — the runtime-read gap: an injected NODE_COMPILE_CACHE that points at a
 * DIFFERENT path than the image-baked compile-cache dir silently bypasses the
 * baked bytecode layer. The bake test
 * (`apps/file-manager/dockerfile-compile-cache-bake.test.ts:149`) proves an
 * injected value WINS over the baked default — that is intentional. The GAP is
 * that when the injected path is a DIFFERENT (e.g. empty PVC) dir, the baked
 * layer is bypassed with no signal, and cold starts silently lose the bake
 * benefit.
 *
 * This adds OBSERVABILITY only (a one-line WARNING), never a behaviour change:
 *  - shadow (override ≠ baked AND a populated baked cache exists) ⇒ warn;
 *  - every uncertain / benign case (unset; override == baked; baked absent or
 *    empty) ⇒ SILENT, fail-open, never throws.
 */

import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    detectCompileCacheShadow,
    isCompileCacheShadowed,
    warnOnCompileCacheShadow,
} from "../adapters/compile-cache-shadow";

const BAKED = "/app/apps/file-manager/.next/compile-cache";

describe("isCompileCacheShadowed (pure)", () => {
    it("shadows when override ≠ baked AND the baked cache is populated", () => {
        expect(isCompileCacheShadowed("/mnt/pvc/cache", BAKED, true)).toBe(
            true,
        );
    });

    it("does NOT shadow when NODE_COMPILE_CACHE is unset", () => {
        expect(isCompileCacheShadowed(undefined, BAKED, true)).toBe(false);
        expect(isCompileCacheShadowed("", BAKED, true)).toBe(false);
    });

    it("does NOT shadow when the override IS the baked dir (the intended win)", () => {
        expect(isCompileCacheShadowed(BAKED, BAKED, true)).toBe(false);
    });

    it("normalizes paths — a trailing slash is still the baked dir", () => {
        expect(isCompileCacheShadowed(`${BAKED}/`, BAKED, true)).toBe(false);
    });

    it("does NOT shadow when the baked cache is absent/empty (nothing bypassed)", () => {
        expect(isCompileCacheShadowed("/mnt/pvc/cache", BAKED, false)).toBe(
            false,
        );
    });
});

describe("detectCompileCacheShadow (filesystem-backed, fail-open)", () => {
    function bakedDir(files: number): string {
        const dir = mkdtempSync(join(tmpdir(), "knext-baked-"));
        for (let i = 0; i < files; i++) {
            writeFileSync(join(dir, `entry-${i}.bin`), "bytecode");
        }
        return dir;
    }

    it("reports a shadow (with file count) when an override bypasses a populated bake", () => {
        const baked = bakedDir(3);
        const result = detectCompileCacheShadow({
            nodeCompileCache: "/mnt/pvc/empty",
            bakedDefaultPath: baked,
        });
        expect(result.shadowed).toBe(true);
        expect(result.bakedFileCount).toBeGreaterThanOrEqual(1);
    });

    it("is silent when the override equals the baked dir", () => {
        const baked = bakedDir(3);
        expect(
            detectCompileCacheShadow({
                nodeCompileCache: baked,
                bakedDefaultPath: baked,
            }).shadowed,
        ).toBe(false);
    });

    it("is silent when the baked dir is empty", () => {
        const baked = bakedDir(0);
        expect(
            detectCompileCacheShadow({
                nodeCompileCache: "/mnt/pvc/empty",
                bakedDefaultPath: baked,
            }).shadowed,
        ).toBe(false);
    });

    it("is silent when the baked dir does not exist (never throws)", () => {
        expect(
            detectCompileCacheShadow({
                nodeCompileCache: "/mnt/pvc/empty",
                bakedDefaultPath: join(tmpdir(), "knext-does-not-exist-xyz"),
            }).shadowed,
        ).toBe(false);
    });

    it("is silent when NODE_COMPILE_CACHE is unset", () => {
        const baked = bakedDir(3);
        expect(
            detectCompileCacheShadow({
                nodeCompileCache: undefined,
                bakedDefaultPath: baked,
            }).shadowed,
        ).toBe(false);
    });
});

describe("warnOnCompileCacheShadow (logger)", () => {
    function makeLog() {
        return { warn: vi.fn(), info: vi.fn() };
    }
    function bakedDir(files: number): string {
        const dir = mkdtempSync(join(tmpdir(), "knext-baked-warn-"));
        for (let i = 0; i < files; i++) {
            writeFileSync(join(dir, `entry-${i}.bin`), "bytecode");
        }
        return dir;
    }

    it("fires exactly one WARNING under the shadow condition", () => {
        const baked = bakedDir(2);
        const log = makeLog();
        warnOnCompileCacheShadow({
            env: { NODE_COMPILE_CACHE: "/mnt/pvc/empty" },
            bakedDefaultPath: baked,
            log,
        });
        expect(log.warn).toHaveBeenCalledTimes(1);
        const msg = String(log.warn.mock.calls[0][1]);
        expect(msg).toMatch(/shadow/i);
    });

    it("stays SILENT when the override is the baked dir", () => {
        const baked = bakedDir(2);
        const log = makeLog();
        warnOnCompileCacheShadow({
            env: { NODE_COMPILE_CACHE: baked },
            bakedDefaultPath: baked,
            log,
        });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("stays SILENT when NODE_COMPILE_CACHE is unset", () => {
        const baked = bakedDir(2);
        const log = makeLog();
        warnOnCompileCacheShadow({
            env: {},
            bakedDefaultPath: baked,
            log,
        });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("never throws even if the logger throws (fail-open)", () => {
        const baked = bakedDir(2);
        const log = {
            warn: vi.fn(() => {
                throw new Error("boom");
            }),
            info: vi.fn(),
        };
        expect(() =>
            warnOnCompileCacheShadow({
                env: { NODE_COMPILE_CACHE: "/mnt/pvc/empty" },
                bakedDefaultPath: baked,
                log,
            }),
        ).not.toThrow();
    });
});

/**
 * #451 item 1 — symlink / bind-mount ALIAS false-warn.
 *
 * The comparison used to be purely lexical (`resolve`), so an operator-injected
 * NODE_COMPILE_CACHE that is a SYMLINK to (or another mount alias of) the baked
 * dir compared as a DIFFERENT path and produced a spurious WARNING. The paths
 * are now canonicalised with `realpathSync` before the inequality check —
 * best-effort: a realpath that throws (a path that does not exist, an
 * unreadable mount) must fall back to the lexical value and NEVER break the
 * check or the boot. This only ever fails toward a false warn, never toward
 * breakage — keep it that way.
 */
describe("#451 realpath aliasing (symlinks / bind-mount aliases)", () => {
    function bakedDir(files: number): string {
        const dir = mkdtempSync(join(tmpdir(), "knext-baked-alias-"));
        for (let i = 0; i < files; i++) {
            writeFileSync(join(dir, `entry-${i}.bin`), "bytecode");
        }
        return dir;
    }

    /** A REAL symlink on disk pointing at `target` — not a mocked realpath. */
    function symlinkTo(target: string): string {
        const link = join(
            mkdtempSync(join(tmpdir(), "knext-alias-link-")),
            "compile-cache",
        );
        symlinkSync(target, link, "dir");
        return link;
    }

    it("does NOT shadow when the override is a symlink to the baked dir (pure)", () => {
        const baked = bakedDir(3);
        const alias = symlinkTo(baked);
        expect(alias).not.toBe(baked); // genuinely a different lexical path
        expect(isCompileCacheShadowed(alias, baked, true)).toBe(false);
    });

    it("does NOT shadow when the BAKED path is reached through a symlink (pure)", () => {
        const baked = bakedDir(3);
        const alias = symlinkTo(baked);
        expect(isCompileCacheShadowed(baked, alias, true)).toBe(false);
    });

    it("still shadows when the symlink points somewhere ELSE", () => {
        const baked = bakedDir(3);
        const other = bakedDir(1);
        const alias = symlinkTo(other);
        expect(isCompileCacheShadowed(alias, baked, true)).toBe(true);
    });

    it("detect + warn stay SILENT for a symlinked override (filesystem)", () => {
        const baked = bakedDir(3);
        const alias = symlinkTo(baked);
        const result = detectCompileCacheShadow({
            nodeCompileCache: alias,
            bakedDefaultPath: baked,
        });
        expect(result.shadowed).toBe(false);

        const log = { warn: vi.fn(), info: vi.fn() };
        warnOnCompileCacheShadow({
            env: { NODE_COMPILE_CACHE: alias },
            bakedDefaultPath: baked,
            log,
        });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("FAILS OPEN when realpath throws: a non-existent override still warns", () => {
        // `realpathSync` throws ENOENT for this override. The check must fall
        // back to the lexical path rather than losing the diagnostic (or
        // throwing) — a genuine shadow of a populated bake is still reported.
        const baked = bakedDir(2);
        const missing = join(tmpdir(), "knext-451-no-such-dir-abc123");
        expect(existsSync(missing)).toBe(false);
        expect(isCompileCacheShadowed(missing, baked, true)).toBe(true);

        const log = { warn: vi.fn(), info: vi.fn() };
        expect(() =>
            warnOnCompileCacheShadow({
                env: { NODE_COMPILE_CACHE: missing },
                bakedDefaultPath: baked,
                log,
            }),
        ).not.toThrow();
        expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it("FAILS OPEN when realpath throws for BOTH paths (never throws)", () => {
        const missingA = join(tmpdir(), "knext-451-missing-a");
        const missingB = join(tmpdir(), "knext-451-missing-b");
        expect(() =>
            isCompileCacheShadowed(missingA, missingB, true),
        ).not.toThrow();
        expect(isCompileCacheShadowed(missingA, missingB, true)).toBe(true);
        // Same lexical path, both unresolvable ⇒ still recognised as the same.
        expect(isCompileCacheShadowed(missingA, missingA, true)).toBe(false);
    });
});
