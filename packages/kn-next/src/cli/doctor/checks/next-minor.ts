/**
 * Installed Next.js minor vs the credentialed list — LOCAL and read-only.
 *
 * The peer range admits only minors with compatibility evidence, but some of
 * those may be admitted without being in the credentialed list. This
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

/** The policy a check run is judged against; defaults to `next-compat.ts`. */
export interface NextMinorPolicy {
    range: string;
    minors: readonly string[];
}

const DEFAULT_POLICY: NextMinorPolicy = {
    range: NEXT_PEER_RANGE,
    minors: CREDENTIALED_NEXT_MINORS,
};

/** `>=A.B.C <D.E.F` -> true when major.minor lies inside it. */
function insideRange(major: number, minor: number, range: string): boolean {
    const m = /^>=(\d+)\.(\d+)\.\d+ <(\d+)\.(\d+)\.\d+$/.exec(range);
    if (!m) return false;
    const at = major * 1e6 + minor;
    return (
        at >= Number(m[1]) * 1e6 + Number(m[2]) &&
        at < Number(m[3]) * 1e6 + Number(m[4])
    );
}

export function nextMinorCheck(
    ctx: CheckContext,
    policy: NextMinorPolicy = DEFAULT_POLICY,
): CheckResult[] {
    const { range, minors } = policy;
    const installed = ctx.deps.readInstalledNext?.();
    if (installed === undefined) return [];

    const credentialed = minors.join(", ");
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
    if (minors.includes(minor)) {
        return [
            mk(
                ID,
                TITLE,
                "pass",
                `Next.js ${installed} is on a credentialed minor (${credentialed})`,
            ),
        ];
    }
    if (!insideRange(v.major, v.minor, range)) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `Next.js ${installed} is outside the range knext declares (${range}); credentialed minors: ${credentialed}`,
                `install a Next.js version inside ${range}, ideally a credentialed minor (${credentialed}.x)`,
            ),
        ];
    }
    return [
        mk(
            ID,
            TITLE,
            "warn",
            `Next.js ${installed} is inside the declared range (${range}) but not a credentialed minor (${credentialed}); it works, but the compatibility evidence does not cover it`,
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
