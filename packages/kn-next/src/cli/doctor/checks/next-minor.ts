/**
 * Installed Next.js minor vs the credentialed list — LOCAL and read-only.
 *
 * The peer range admits only minors with compatibility evidence, but some of
 * those (16.0-16.2, 16.4) are admitted without being in the credential. This
 * row says so instead of leaving the user to assume parity. WARN only: a
 * warning never blocks an install or a build.
 * No Next.js resolvable -> no row, so reports for other setups are unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
    CREDENTIALED_NEXT_MINORS,
    NEXT_PEER_RANGE,
} from "../../../next-compat";
import { parseSemver } from "../operator-version";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

const ID = "next-minor";
const TITLE = "Next.js minor is credentialed";

export function nextMinorCheck(ctx: CheckContext): CheckResult[] {
    const installed = ctx.deps.readInstalledNext?.();
    if (installed === undefined) return [];

    const credentialed = CREDENTIALED_NEXT_MINORS.join(", ");
    const v = parseSemver(installed);
    if (v === undefined) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `Next.js ${installed} is not a version number knext can compare with the credentialed minors (${credentialed})`,
                `install a credentialed Next.js minor (${credentialed}.x)`,
            ),
        ];
    }
    const minor = `${v.major}.${v.minor}`;
    if (CREDENTIALED_NEXT_MINORS.includes(minor)) {
        return [
            mk(
                ID,
                TITLE,
                "pass",
                `Next.js ${installed} is on a credentialed minor (${credentialed})`,
            ),
        ];
    }
    const below = v.major < 16;
    const above = v.major > 16 || v.minor >= 5;
    if (below || above) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `Next.js ${installed} is outside the range knext declares (${NEXT_PEER_RANGE}); credentialed minors: ${credentialed}`,
                `install a Next.js version inside ${NEXT_PEER_RANGE}, ideally a credentialed minor (${credentialed}.x)`,
            ),
        ];
    }
    return [
        mk(
            ID,
            TITLE,
            "warn",
            `Next.js ${installed} is inside the declared range (${NEXT_PEER_RANGE}) but not a credentialed minor (${credentialed}); it works, but the official compatibility results do not cover it`,
            `use a credentialed minor (${credentialed}.x) if you need the compatibility guarantee`,
        ),
    ];
}

/** The version of the `next` an app at `cwd` would load, or undefined. */
export function readInstalledNextVersion(cwd: string): string | undefined {
    let dir = resolve(cwd);
    for (;;) {
        const pkg = join(dir, "node_modules", "next", "package.json");
        if (existsSync(pkg)) {
            try {
                const v = (
                    JSON.parse(readFileSync(pkg, "utf8")) as {
                        version?: unknown;
                    }
                ).version;
                return typeof v === "string" ? v : undefined;
            } catch {
                return undefined;
            }
        }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}
