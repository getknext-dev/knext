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

import { mkdtempSync, writeFileSync } from "node:fs";
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
