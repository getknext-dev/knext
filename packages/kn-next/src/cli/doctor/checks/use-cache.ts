/**
 * `'use cache'` is per-pod on knext today (#2083, 1.x interim) -- LOCAL and
 * read-only, so it runs even when the cluster is unreachable.
 *
 * The scaffold sets `cacheMaxMemorySize: 0` and wires no `cacheHandlers`, so a
 * server-side `'use cache'` entry is either off or held in one pod's memory and
 * lost on scale-to-zero; it is never shared across pods. Next requires
 * `cacheComponents` (or the older `experimental.useCache`) to be enabled for
 * `'use cache'` to be usable at all, so reading the app's `next.config` for
 * that flag is a cheap and sufficient detector.
 *
 * Contributes NO row when the flag is absent, which keeps every other app's
 * row set byte-identical (doctor-golden.test.ts). WARN only, never a failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

const NEXT_CONFIG_FILES = [
    "next.config.ts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
    "next.config.mts",
];

/** Strip // and block comments so a commented-out flag does not count. */
function stripComments(src: string): string {
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

export function cacheComponentsCheck(ctx: CheckContext): CheckResult[] {
    const text = (ctx.deps.readNextConfigFile ?? defaultReadNextConfig)();
    if (text === undefined || !enablesUseCache(text)) return [];
    return [
        mk(
            "use-cache",
            "'use cache' is per-pod",
            "warn",
            "this app enables cacheComponents: server-side 'use cache' entries are per-pod and are not shared across pods or kept across scale-to-zero (with the scaffold's cacheMaxMemorySize: 0 they are off)",
            "treat 'use cache' as a per-pod optimisation, not a shared cache; see https://knext-platform.dev/docs/isr-caching",
        ),
    ];
}
