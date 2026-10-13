/**
 * `'use cache'` has no shared store on knext 1.x (#2277) -- LOCAL and
 * read-only, so it runs even when the cluster is unreachable.
 *
 * Nothing backs Next's `'use cache'` directive with a shared store on the 1.x
 * line: an entry lives in one server process's memory (one per pod), is not
 * shared across pods, and is lost on scale-to-zero. Under the scaffold's
 * `cacheMaxMemorySize: 0` it keeps nothing at all, so the directive is
 * effectively a no-op. This check says which of the two applies.
 *
 * DETECTION reads the app's SOURCE for the directive, not the build output
 * and not the `cacheComponents` flag: doctor usually runs before a build (so
 * `.next/` is absent or stale, and its layout is a Next internal), and many
 * apps enable `cacheComponents` for partial prerendering without ever writing
 * `'use cache'` -- warning those would be noise.
 *
 * Contributes NO row when the app does not use the directive (or there is no
 * `next.config` in the current directory), which keeps every other app's row
 * set byte-identical (doctor-golden.test.ts). WARN only, never a failure.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

export const NEXT_CONFIG_FILES = [
    "next.config.ts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
    "next.config.mts",
];

const DOCS_URL = "https://knext-platform.dev/docs/isr-caching";

/** Source extensions a `'use cache'` directive can live in. */
const SOURCE_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
]);

/** Dependency and build-output directories -- never the app's own source. */
const SKIPPED_DIRS = new Set([
    "node_modules",
    "out",
    "dist",
    "build",
    "coverage",
]);

/** Bounds so a pathological tree cannot stall the preflight. */
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;

/** Strip // and block comments so a commented-out flag does not count. */
export function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * True iff the source carries a `'use cache'` directive (incl. the
 * `'use cache: remote'` / `'use cache: private'` variants). A directive is a
 * string-literal statement on its own line -- at the top of a file or of a
 * function body -- so an ordinary string value or a comment does not count.
 */
export function hasUseCacheDirective(src: string): boolean {
    return /^[ \t]*(["'])use cache(?::[ \t]*[\w-]+)?\1[ \t]*;?[ \t]*$/m.test(
        stripComments(src),
    );
}

/** True iff the next.config text sets `cacheMaxMemorySize: 0`. */
export function setsZeroCacheMemory(configText: string): boolean {
    return /\bcacheMaxMemorySize\s*:\s*0(?![\w.])/.test(
        stripComments(configText),
    );
}

/**
 * The first app source file (relative to `root`, in sorted walk order) that
 * uses `'use cache'`, or undefined. Skips dependencies, build output and
 * dot-directories (`.next`, `.git`, ...). Never throws: an unreadable entry is
 * skipped, because doctor must not crash on the state it is diagnosing.
 */
export function findUseCacheFile(root: string): string | undefined {
    let seen = 0;
    const walk = (dir: string): string | undefined => {
        let names: string[];
        try {
            names = readdirSync(dir).sort();
        } catch {
            return undefined;
        }
        for (const name of names) {
            if (seen >= MAX_FILES) return undefined;
            if (name.startsWith(".")) continue;
            const full = join(dir, name);
            let st: ReturnType<typeof statSync>;
            try {
                st = statSync(full);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                if (SKIPPED_DIRS.has(name)) continue;
                const hit = walk(full);
                if (hit !== undefined) return hit;
                continue;
            }
            if (!st.isFile() || !SOURCE_EXTENSIONS.has(extname(name))) continue;
            seen++;
            if (st.size > MAX_FILE_BYTES) continue;
            try {
                if (hasUseCacheDirective(readFileSync(full, "utf8"))) {
                    return relative(root, full);
                }
            } catch {
                // unreadable: skip it
            }
        }
        return undefined;
    };
    return walk(root);
}

function defaultReadNextConfig(): string | undefined {
    for (const name of NEXT_CONFIG_FILES) {
        const path = join(process.cwd(), name);
        if (!existsSync(path)) continue;
        try {
            return readFileSync(path, "utf8");
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export function cacheDirectiveCheck(ctx: CheckContext): CheckResult[] {
    const config = (ctx.deps.readNextConfigFile ?? defaultReadNextConfig)();
    if (config === undefined) return [];
    const file = (
        ctx.deps.findUseCacheFile ?? (() => findUseCacheFile(process.cwd()))
    )();
    if (file === undefined) return [];
    if (setsZeroCacheMemory(config)) {
        return [
            mk(
                "use-cache",
                "'use cache' is a no-op",
                "warn",
                `${file} uses 'use cache', but next.config sets cacheMaxMemorySize: 0, so nothing is kept: the directive is effectively a no-op. Your code still runs and returns correct results; it is just not cached.`,
                `keep cacheMaxMemorySize: 0 (raising it lets each pod's in-memory cache drift from the shared Redis cache); remove the directive, or move data that must be cached into ISR or your own data store. See ${DOCS_URL}`,
            ),
        ];
    }
    return [
        mk(
            "use-cache",
            "'use cache' is per-process",
            "warn",
            `${file} uses 'use cache': its entries are per-process, held in each pod's own memory, so they are not shared across pods and are lost on scale-to-zero.`,
            `treat 'use cache' as a per-pod speed-up, not a shared cache; keep anything that must be shared, or must survive scale-to-zero, in ISR or your own data store. See ${DOCS_URL}`,
        ),
    ];
}
