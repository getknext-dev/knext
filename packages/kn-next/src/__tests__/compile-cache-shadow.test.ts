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
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    detectCompileCacheShadow,
    isCompileCacheShadowed,
    isSameDirectory,
    type StatFn,
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
 * dir compared as a DIFFERENT path and produced a spurious WARNING.
 *
 * Sameness is now decided by TWO mechanisms, and they cover different cases:
 *  - canonical path equality (`realpathSync`) — trailing slash, `.`/`..`,
 *    SYMLINKS;
 *  - filesystem-node identity (`dev` + `ino`) — BIND MOUNTS, which
 *    `realpathSync` alone cannot see because it never reads the mount table.
 *
 * Both stay best-effort: a realpath or a stat that throws (path absent,
 * unreadable parent, ELOOP) falls back to "not the same", which at worst
 * restores the old spurious warning and NEVER breaks the check or the boot.
 */
describe("#451 realpath aliasing (symlinks)", () => {
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

/**
 * #451 item 1, second mechanism — BIND-MOUNT aliases.
 *
 * `realpathSync` resolves symlinks and `.`/`..`; it does NOT consult the mount
 * table. Two separate bind mounts of the same directory are two real paths that
 * each canonicalise to themselves, so path comparison alone still reports a
 * false shadow. What identifies them is the filesystem node: same `dev`, same
 * `ino`.
 *
 * A bind mount cannot be created from a unit test (it needs root), so the stat
 * function is injected. This is the ONLY seam — production always uses
 * `statSync`, and the symlink cases above exercise the real filesystem.
 */
describe("#451 bind-mount aliases (dev/ino identity)", () => {
    const BAKED_MOUNT = "/app/.next/compile-cache";
    const ALIAS_MOUNT = "/mnt/compile-cache";

    /** Both paths are the same fs node — what a bind mount looks like. */
    const sameNode: StatFn = () => ({ dev: 66, ino: 1234 });

    /** Genuinely different directories. */
    const distinctNodes: StatFn = (p) =>
        p === BAKED_MOUNT ? { dev: 66, ino: 1234 } : { dev: 66, ino: 9999 };

    it("does NOT shadow when two distinct paths are the same fs node", () => {
        // Sanity: these are unequal as paths, so only dev/ino can save them.
        expect(resolve(ALIAS_MOUNT)).not.toBe(resolve(BAKED_MOUNT));
        expect(
            isCompileCacheShadowed(ALIAS_MOUNT, BAKED_MOUNT, true, sameNode),
        ).toBe(false);
        expect(isSameDirectory(ALIAS_MOUNT, BAKED_MOUNT, sameNode)).toBe(true);
    });

    it("still shadows when the fs nodes differ (diagnostic not weakened)", () => {
        expect(
            isCompileCacheShadowed(
                ALIAS_MOUNT,
                BAKED_MOUNT,
                true,
                distinctNodes,
            ),
        ).toBe(true);
        expect(isSameDirectory(ALIAS_MOUNT, BAKED_MOUNT, distinctNodes)).toBe(
            false,
        );
    });

    it("requires BOTH dev and ino to match (same ino on another device)", () => {
        const sameInoOtherDev: StatFn = (p) =>
            p === BAKED_MOUNT ? { dev: 66, ino: 1234 } : { dev: 77, ino: 1234 };
        expect(
            isCompileCacheShadowed(
                ALIAS_MOUNT,
                BAKED_MOUNT,
                true,
                sameInoOtherDev,
            ),
        ).toBe(true);
    });

    it("FAILS OPEN when the stat throws (never throws, keeps the warning)", () => {
        const throwing: StatFn = () => {
            throw new Error("EACCES");
        };
        expect(() =>
            isCompileCacheShadowed(ALIAS_MOUNT, BAKED_MOUNT, true, throwing),
        ).not.toThrow();
        expect(
            isCompileCacheShadowed(ALIAS_MOUNT, BAKED_MOUNT, true, throwing),
        ).toBe(true);
        // ...but an identical path still short-circuits on canonical equality,
        // so a throwing stat cannot manufacture a warning either.
        expect(
            isCompileCacheShadowed(BAKED_MOUNT, BAKED_MOUNT, true, throwing),
        ).toBe(false);
    });

    it("defaults to the real statSync when no seam is passed", () => {
        // Two real, genuinely different dirs must still shadow with the
        // production stat — i.e. the default parameter is wired.
        const a = mkdtempSync(join(tmpdir(), "knext-451-devino-a-"));
        const b = mkdtempSync(join(tmpdir(), "knext-451-devino-b-"));
        expect(isCompileCacheShadowed(a, b, true)).toBe(true);
        expect(isSameDirectory(a, a)).toBe(true);
    });
});
