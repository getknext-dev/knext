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
 * through symlinks / mount aliases (`realpathSync`) on a BEST-EFFORT basis
 * (#451).
 *
 * `realpathSync` throws for a path that does not exist (the common case for an
 * injected-but-not-yet-mounted NODE_COMPILE_CACHE) and for an unreadable mount.
 * Those must NOT break the check or the boot, so a throw falls back to the
 * lexical value — exactly the pre-#451 behaviour. The failure mode of this
 * whole module is a spurious WARN, never breakage; keep it that way.
 */
function canonicalPath(p: string): string {
    const abs = resolve(p);
    try {
        return realpathSync(abs);
    } catch {
        return abs;
    }
}

/**
 * Pure shadow decision — unit-testable without a filesystem.
 *
 * A shadow exists when NODE_COMPILE_CACHE is set to a path that is NOT the
 * baked-default compile-cache dir AND a populated baked cache exists at the
 * baked-default path (a real baked layer is being bypassed). Paths are
 * normalized (via `resolve`) so a trailing slash / `.` segment is not mistaken
 * for a different dir, and canonicalised through `realpathSync` (#451) so an
 * operator-injected value that is a SYMLINK to — or a bind-mount alias of — the
 * baked dir is recognised as the same dir instead of producing a false warn.
 */
export function isCompileCacheShadowed(
    nodeCompileCache: string | undefined,
    bakedDefaultPath: string,
    bakedPopulated: boolean,
): boolean {
    if (!nodeCompileCache) return false;
    if (!bakedPopulated) return false;
    return canonicalPath(nodeCompileCache) !== canonicalPath(bakedDefaultPath);
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
