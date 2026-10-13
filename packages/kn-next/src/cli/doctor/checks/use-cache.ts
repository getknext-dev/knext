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
 * set byte-identical (doctor-golden.test.ts). WARN only, never a failure. When
 * the bounded scan stops early without a hit, it says so in a WARN row rather
 * than returning a silent "no row".
 *
 * ACCEPTED FALSE POSITIVES (the detector is line-based, not a parser, and the
 * row is warn-only): a directive-shaped line inside a multi-line template
 * literal, or a `'use cache'` string alone on its line as a call argument.
 * A regex literal containing a quote can also confuse the comment stripper.
 */

import {
    type Dirent,
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
} from "node:fs";
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

/** Dependency directories, skipped at every depth. */
const ALWAYS_SKIPPED_DIRS = new Set(["node_modules"]);

/**
 * Build output and Next's static-asset folder, skipped only at the app root
 * (`app/build/` is source). `public/` never holds a directive, and a large
 * one would otherwise eat the cap and trigger a false "scan incomplete".
 */
const ROOT_ONLY_SKIPPED_DIRS = new Set([
    "out",
    "dist",
    "build",
    "coverage",
    "public",
]);

export interface ScanLimits {
    /** Directories and source files count; other files (assets) do not. */
    maxEntries: number;
    /** Larger source files are skipped (generated code, not hand-written). */
    maxFileBytes: number;
}

/** Bounds so a pathological tree cannot stall the preflight. */
export const DEFAULT_SCAN_LIMITS: ScanLimits = {
    maxEntries: 20000,
    maxFileBytes: 1024 * 1024,
};

export interface UseCacheScan {
    /** The first source file (relative path) using the directive, if any. */
    file: string | undefined;
    /** True when the scan hit `maxEntries` before finding a file. */
    truncated: boolean;
}

/** Filesystem seam for {@link scanUseCache} (tests inject Dirents). */
export interface ScanIO {
    /** `readdirSync(dir, { withFileTypes: true })` by default. */
    readdir?: (dir: string) => Dirent[];
}

/**
 * Remove // and block comments from source while leaving string and
 * template-literal contents untouched, so `'/api/*'` does not open a
 * "comment" that swallows the code after it. Block comments keep their
 * newlines, so the line structure the directive regex relies on survives.
 */
export function stripCodeComments(src: string): string {
    let out = "";
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '"' || c === "'" || c === "`") {
            const start = i;
            i++;
            while (i < n && src[i] !== c) {
                if (src[i] === "\\") i++;
                else if (c !== "`" && src[i] === "\n") break;
                i++;
            }
            i++;
            out += src.slice(start, i);
            continue;
        }
        if (c === "/" && src[i + 1] === "/") {
            while (i < n && src[i] !== "\n") i++;
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            const end = src.indexOf("*/", i + 2);
            const stop = end === -1 ? n : end + 2;
            out += src.slice(i, stop).replace(/[^\n]/g, "");
            i = stop;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * True iff the source carries a `'use cache'` directive (incl. the
 * `'use cache: remote'` / `'use cache: private'` variants). A directive is a
 * string-literal statement at the start of a line or right after `{` (the
 * one-line function-body form), ended by `;`, `}` or the end of the line --
 * so an ordinary string value, an object key or a comment does not count.
 */
export function hasUseCacheDirective(src: string): boolean {
    return /(?:^|\{)[ \t]*(["'])use cache(?::[ \t]*[\w-]+)?\1[ \t]*(?:;|\}|$)/m.test(
        stripCodeComments(src.replace(/^\uFEFF/, "")),
    );
}

/** True iff the next.config text sets `cacheMaxMemorySize: 0` (quoted key too). */
export function setsZeroCacheMemory(configText: string): boolean {
    return /(?:^|[^\w$])(["']?)cacheMaxMemorySize\1\s*:\s*0(?![\w.])/m.test(
        stripCodeComments(configText),
    );
}

/**
 * Find the first app source file (relative to `root`, in sorted walk order)
 * that uses `'use cache'`. Skips symlinks (no loops, no escaping the app),
 * dot-directories (`.next`, `.git`, ...), `node_modules` at any depth and
 * build output and `public/` at the root. Directories and source files count
 * toward `limits.maxEntries` (other files cost no syscall: the walk reads
 * entry types from `readdir`, with an `lstat` fallback only where `readdir`
 * reports no type); hitting the cap sets `truncated`. Never throws: an
 * unreadable entry is skipped, because doctor must not crash on the state it
 * is diagnosing.
 */
export function scanUseCache(
    root: string,
    limits: ScanLimits = DEFAULT_SCAN_LIMITS,
    io: ScanIO = {},
): UseCacheScan {
    const readdir =
        io.readdir ??
        ((dir: string) => readdirSync(dir, { withFileTypes: true }));
    let entries = 0;
    let truncated = false;
    const walk = (dir: string, atRoot: boolean): string | undefined => {
        let dirents: Dirent[];
        try {
            dirents = readdir(dir);
        } catch {
            return undefined;
        }
        dirents.sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        for (const d of dirents) {
            const name = d.name;
            if (name.startsWith(".")) continue;
            // Dirent types come from readdir without following links: a
            // symlink is neither a directory nor a file here, so it is never
            // followed (no loops, no escaping the app root).
            let isDir = d.isDirectory();
            let isFile = d.isFile();
            if (!isDir && !isFile && !d.isSymbolicLink()) {
                // No type from readdir (DT_UNKNOWN on some filesystems):
                // ask lstat, which -- unlike stat -- does not follow a link.
                try {
                    const st = lstatSync(join(dir, name));
                    isDir = st.isDirectory();
                    isFile = st.isFile();
                } catch {
                    continue;
                }
            }
            if (isDir) {
                if (ALWAYS_SKIPPED_DIRS.has(name)) continue;
                if (atRoot && ROOT_ONLY_SKIPPED_DIRS.has(name)) continue;
            } else if (!isFile || !SOURCE_EXTENSIONS.has(extname(name))) {
                continue;
            }
            if (entries >= limits.maxEntries) {
                truncated = true;
                return undefined;
            }
            entries++;
            const full = join(dir, name);
            if (isDir) {
                const hit = walk(full, false);
                if (hit !== undefined || truncated) return hit;
                continue;
            }
            let size: number;
            try {
                size = lstatSync(full).size;
            } catch {
                continue;
            }
            if (size > limits.maxFileBytes) continue;
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
    const file = walk(root, true);
    return { file, truncated: file === undefined && truncated };
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
    const scan = (
        ctx.deps.scanUseCache ?? (() => scanUseCache(process.cwd()))
    )();
    const file = scan.file;
    if (file === undefined) {
        if (!scan.truncated) return [];
        return [
            mk(
                "use-cache",
                "'use cache' scan incomplete",
                "warn",
                "the source scan for 'use cache' stopped early because this directory holds too many files, so doctor could not tell whether the app uses it.",
                `run doctor from the app directory (the one with next.config). If the app uses 'use cache', its entries are per-process on knext and are not shared across pods. See ${DOCS_URL}`,
            ),
        ];
    }
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
