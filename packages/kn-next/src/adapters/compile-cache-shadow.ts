/**
 * compile-cache-shadow.ts — make the NODE_COMPILE_CACHE "shadow" case observable
 * (#440).
 *
 * ## The gap
 *
 * knext bakes the V8 compile cache into the image at build time (ADR-0035 /
 * #437/#438). The Dockerfile CMD points NODE_COMPILE_CACHE at the baked default
 * (the standalone `.next/compile-cache` dir) via `${NODE_COMPILE_CACHE:-…}`, so
 * an operator-injected NODE_COMPILE_CACHE WINS over the baked default — that is
 * intentional and asserted by the bake test
 * (`apps/file-manager/dockerfile-compile-cache-bake.test.ts:149`).
 *
 * But if the injected value points at a DIFFERENT path (e.g. an empty PVC), the
 * baked cache layer is silently bypassed: it fails OPEN and invisible, and every
 * cold start quietly loses the bytecode-cache benefit with no signal. Existing
 * coverage proves the cache is WRITTEN and REUSED-when-same-dir
 * (`apps/file-manager/bytecode-cache-reuse.test.ts`, the
 * `kn_next_bytecode_cache_warm_start` gauge) — nothing makes the SHADOW case
 * observable. This module closes that: a single one-line WARNING at supervisor
 * startup when a real baked layer is being bypassed.
 *
 * ## Fail-open, off the critical path
 *
 * This is DIAGNOSTICS, not behaviour: it never throws, never delays or breaks
 * boot, and stays SILENT on any uncertainty (can't stat, baked dir absent/empty,
 * override == baked path, or NODE_COMPILE_CACHE unset). The check is cheap — a
 * stat + a shallow readdir count.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

interface ShadowLogger {
    warn(obj: object, msg: string): void;
}

/**
 * Canonicalise a path for comparison: absolute (`resolve`), then resolved
 * through SYMLINKS and `.`/`..` segments (`realpathSync`) on a BEST-EFFORT
 * basis (#451).
 *
 * `realpathSync` throws for a path that does not exist (the common case for an
 * injected-but-not-yet-mounted NODE_COMPILE_CACHE) and for an unreadable mount.
 * Those must NOT break the check or the boot, so a throw falls back to the
 * lexical value — exactly the pre-#451 behaviour. The failure mode of this
 * whole module is a spurious WARN, never breakage; keep it that way.
 *
 * NOTE what this does NOT do: `realpathSync` does not consult the mount table,
 * so two separate bind mounts of the same directory canonicalise to themselves
 * and still compare unequal. That case is covered by the inode identity check
 * in {@link isSameDirectory}, not here.
 */
function canonicalPath(p: string): string {
    const abs = resolve(p);
    try {
        return realpathSync(abs);
    } catch {
        return abs;
    }
}

/** The only two `statSync` fields this module needs; a seam for tests. */
export interface FsNodeIdentity {
    readonly dev: number;
    readonly ino: number;
}

export type StatFn = (path: string) => FsNodeIdentity;

/**
 * Are these two paths the SAME directory? (#451)
 *
 * Two independent mechanisms, in cost order:
 *
 *  1. **Canonical path equality** — catches trailing slashes, `.`/`..`, and
 *     SYMLINKS (`realpathSync`).
 *  2. **Filesystem-node identity** (`dev` + `ino`) — catches what step 1
 *     cannot: a **bind mount** (or any other mount alias) of the same
 *     directory. `realpathSync` does not read the mount table, so `/app/cache`
 *     and `/mnt/cache` bind-mounted to the same dir both canonicalise to
 *     themselves; their `(dev, ino)` pair is identical.
 *
 * Fail-open in the same direction as the rest of the module: if either stat
 * throws (path absent, unreadable parent, ELOOP), we report "not the same",
 * which at worst yields the pre-#451 spurious warning and never an exception.
 */
export function isSameDirectory(
    a: string,
    b: string,
    statFn: StatFn = statSync,
): boolean {
    if (canonicalPath(a) === canonicalPath(b)) return true;
    try {
        const left = statFn(a);
        const right = statFn(b);
        return left.dev === right.dev && left.ino === right.ino;
    } catch {
        return false;
    }
}

/**
 * Pure shadow decision — unit-testable without a filesystem.
 *
 * A shadow exists when NODE_COMPILE_CACHE is set to a path that is NOT the
 * baked-default compile-cache dir AND a populated baked cache exists at the
 * baked-default path (a real baked layer is being bypassed). "Not the same
 * dir" is decided by {@link isSameDirectory}, so a trailing slash, a `.`
 * segment, a SYMLINK, or a BIND-MOUNT alias of the baked dir is recognised as
 * the same dir instead of producing a false warn (#451).
 *
 * `statFn` exists so the inode-identity branch is testable — a bind mount
 * cannot be created in a unit test without root. Production always uses
 * `statSync`.
 */
export function isCompileCacheShadowed(
    nodeCompileCache: string | undefined,
    bakedDefaultPath: string,
    bakedPopulated: boolean,
    statFn: StatFn = statSync,
): boolean {
    if (!nodeCompileCache) return false;
    if (!bakedPopulated) return false;
    return !isSameDirectory(nodeCompileCache, bakedDefaultPath, statFn);
}

export interface CompileCacheShadowResult {
    readonly shadowed: boolean;
    /** Number of files found at the baked-default path (0 when absent/empty). */
    readonly bakedFileCount: number;
}

/**
 * Cheaply count regular files directly under `dir` (shallow, non-recursive).
 * Returns 0 on any error — the baked dir being absent/unreadable is exactly a
 * "nothing to shadow" case, so it must never throw.
 */
function shallowFileCount(dir: string): number {
    try {
        const st = statSync(dir);
        if (!st.isDirectory()) return 0;
        let count = 0;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile()) count++;
        }
        return count;
    } catch {
        return 0;
    }
}

/**
 * Filesystem-backed shadow detection. Stats the baked-default path, counts its
 * files, and applies {@link isCompileCacheShadowed}. Fail-open: any error is
 * treated as "not populated" ⇒ no shadow.
 */
export function detectCompileCacheShadow(opts: {
    nodeCompileCache: string | undefined;
    bakedDefaultPath: string;
}): CompileCacheShadowResult {
    const bakedFileCount = shallowFileCount(opts.bakedDefaultPath);
    const shadowed = isCompileCacheShadowed(
        opts.nodeCompileCache,
        opts.bakedDefaultPath,
        bakedFileCount > 0,
    );
    return { shadowed, bakedFileCount };
}

/**
 * Emit a one-line WARNING when the injected NODE_COMPILE_CACHE shadows a
 * populated image-baked compile cache. Silent otherwise. Never throws —
 * wrapped so a logger fault or a stat race can never affect boot.
 */
export function warnOnCompileCacheShadow(opts: {
    env: Record<string, string | undefined>;
    bakedDefaultPath: string;
    log: ShadowLogger;
}): void {
    try {
        const nodeCompileCache = opts.env.NODE_COMPILE_CACHE;
        const { shadowed, bakedFileCount } = detectCompileCacheShadow({
            nodeCompileCache,
            bakedDefaultPath: opts.bakedDefaultPath,
        });
        if (!shadowed) return;
        opts.log.warn(
            {
                nodeCompileCache,
                bakedDefaultPath: opts.bakedDefaultPath,
                bakedFileCount,
            },
            `NODE_COMPILE_CACHE=${nodeCompileCache} shadows the image-baked compile cache at ${opts.bakedDefaultPath} (${bakedFileCount} files); the baked bytecode will not be used — cold starts lose the bake benefit.`,
        );
    } catch {
        // Diagnostics must never affect boot. Stay silent on any fault.
    }
}
