/**
 * Installed Next.js vs published security advisories — LOCAL and read-only.
 *
 * FAIL (exit 1) when the `next` an app would load is inside the affected range
 * of a critical/high advisory that has a fix: the app is exploitable as
 * deployed, and the remedy is a dependency bump. Kept as its own row rather
 * than folded into `next-minor`, which is a compatibility statement that only
 * ever warns. No Next.js resolvable -> no row, so reports for other setups are
 * unchanged.
 */

import {
    isComparableNextVersion,
    nextAdvisoriesFor,
} from "../../../next-advisories";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

const ID = "next-advisories";
const TITLE = "Next.js has no known critical/high advisory";

/** Higher of two `X.Y.Z` strings (both come from the advisory table). */
function maxVersion(a: string, b: string): string {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] > pb[i] ? a : b;
    }
    return a;
}

export function nextAdvisoriesCheck(ctx: CheckContext): CheckResult[] {
    const installed = ctx.deps.readInstalledNext?.();
    if (installed === undefined) return [];

    if (!isComparableNextVersion(installed)) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `Next.js ${installed} is not a version number knext can check against the published security advisories`,
                "install a released Next.js version so it can be checked",
            ),
        ];
    }

    const hits = nextAdvisoriesFor(installed);
    if (hits.length === 0) {
        return [
            mk(
                ID,
                TITLE,
                "pass",
                `Next.js ${installed} is not affected by any critical/high advisory knext checks for`,
            ),
        ];
    }

    const fixed = hits.map((h) => h.fixed).reduce(maxVersion);
    const list = hits
        .map((h) => `${h.id} (${h.severity}: ${h.summary})`)
        .join("; ");
    return [
        mk(
            ID,
            TITLE,
            "fail",
            `Next.js ${installed} is affected by ${hits.length} published advisor${hits.length === 1 ? "y" : "ies"}: ${list}`,
            `upgrade next to ${fixed} or later and rebuild the app`,
        ),
    ];
}
