/**
 * `'use cache'` on knext: shared through Redis when the adapter wires it (#2083).
 *
 * LOCAL and read-only, so it runs even when the cluster is unreachable. Next
 * requires `cacheComponents` (or the older `experimental.useCache`) for
 * `'use cache'` to be usable at all, so reading the app's `next.config` for that
 * flag is a cheap and sufficient detector.
 *
 * The knext adapter points `cacheHandlers` (`default` and `remote`) at its Redis
 * handler whenever the app uses knext's `cacheHandler`, so an app that sets
 * `cacheHandler` has `'use cache'` shared across pods. An app with NO
 * `cacheHandler` gets Next's built-in handler, which is per-pod and (with the
 * scaffold's `cacheMaxMemorySize: 0`) off: that is the WARN. An app that sets
 * its own `cacheHandlers` owns the choice, so no row.
 *
 * Contributes NO row when the flag is absent, which keeps every other app's
 * row set byte-identical (doctor-golden.test.ts). WARN only, never a failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

export const NEXT_CONFIG_FILES = [
    "next.config.ts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
    "next.config.mts",
];

/** Strip // and block comments so a commented-out flag does not count. */
export function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** True iff the config text enables Cache Components / `'use cache'`. */
export function enablesUseCache(configText: string): boolean {
    return /\b(cacheComponents|useCache)\s*:\s*true\b/.test(
        stripComments(configText),
    );
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

/** True iff the (comment-stripped) config sets the named top-level option. */
function sets(configText: string, option: string): boolean {
    return new RegExp(`\\b${option}\\s*:`).test(stripComments(configText));
}

export function cacheComponentsCheck(ctx: CheckContext): CheckResult[] {
    const text = (ctx.deps.readNextConfigFile ?? defaultReadNextConfig)();
    if (text === undefined || !enablesUseCache(text)) return [];
    // The app chose its own 'use cache' backend: nothing for knext to claim.
    if (sets(text, "cacheHandlers")) return [];
    if (sets(text, "cacheHandler")) {
        return [
            mk(
                "use-cache",
                "'use cache' is shared across pods",
                "pass",
                "this app enables cacheComponents and uses knext's cacheHandler: the adapter also wires the Redis 'use cache' handler, so entries are shared across pods and kept across scale-to-zero (needs REDIS_URL; without Redis 'use cache' entries are not cached)",
            ),
        ];
    }
    return [
        mk(
            "use-cache",
            "'use cache' is per-pod",
            "warn",
            "this app enables cacheComponents but sets no cacheHandler: server-side 'use cache' entries use Next's built-in handler, which is per-pod, not shared across pods and lost on scale-to-zero",
            "set cacheHandler to knext's handler (the scaffold's cache-handler.js) so the adapter can wire the shared Redis 'use cache' backend; see https://knext-platform.dev/docs/isr-caching",
        ),
    ];
}
