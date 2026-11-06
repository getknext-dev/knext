/**
 * Installed Next.js minor vs the credentialed list — LOCAL and read-only.
 *
 * The peer range admits only minors with compatibility evidence, but some of
 * those (16.0-16.2, 16.4) are admitted without being in the credential. This
 * row says so instead of leaving the user to assume parity. WARN only: a
 * warning never blocks an install or a build.
 *
 * #2594: the row is advisory-aware. It never PASSes a version the
 * `next-advisories` row FAILs, and its hints never point at a minor that has
 * no release fixing a known advisory — on 1.x the credentialed 16.3 is such a
 * minor, so "use a credentialed minor" would tell a patched user to downgrade
 * into the RCEs. The minor it recommends is the credentialed one when that is
 * fixable, else the security-forced one (`SECURITY_FORCED_NEXT_MINORS`).
 * No Next.js resolvable -> no row, so reports for other setups are unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
    minorWithoutFixedRelease,
    nextAdvisoriesFor,
} from "../../../next-advisories";
import {
    CREDENTIALED_NEXT_MINORS,
    NEXT_PEER_RANGE,
    SECURITY_FORCED_NEXT_MINORS,
} from "../../../next-compat";
import { parseSemver } from "../operator-version";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

const ID = "next-minor";
const TITLE = "Next.js minor is credentialed";

/**
 * The minors a hint may recommend: credentialed minors that have a release
 * fixing every known advisory, then the security-forced minors. Never a minor
 * from {@link minorWithoutFixedRelease}.
 */
export function recommendedNextMinors(): string[] {
    const out: string[] = [];
    for (const minor of [
        ...CREDENTIALED_NEXT_MINORS,
        ...SECURITY_FORCED_NEXT_MINORS.map((f) => f.minor),
    ]) {
        if (minorWithoutFixedRelease(minor).length > 0) continue;
        if (!out.includes(minor)) out.push(minor);
    }
    return out;
}

/** Higher of two `X.Y.Z` strings (both from the advisory table). */
function maxVersion(a: string, b: string): string {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] > pb[i] ? a : b;
    }
    return a;
}

export function nextMinorCheck(ctx: CheckContext): CheckResult[] {
    const installed = ctx.deps.readInstalledNext?.();
    if (installed === undefined) return [];

    const credentialed = CREDENTIALED_NEXT_MINORS.join(", ");
    const recommended = recommendedNextMinors()
        .map((m) => `${m}.x`)
        .join(" or ");
    const v = parseSemver(installed);
    if (v === undefined) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `Next.js ${installed} is not a version number knext can compare with the credentialed minors (${credentialed})`,
                `install a released Next.js on ${recommended}`,
            ),
        ];
    }

    const hits = nextAdvisoriesFor(installed);
    const advisoryNote =
        hits.length > 0
            ? `; it is also affected by ${hits.map((h) => h.id).join(", ")} (see the next-advisories row)`
            : "";
    const upgradeHint =
        hits.length > 0
            ? `upgrade next to ${hits.map((h) => h.fixed).reduce(maxVersion)} or later (${recommended})`
            : undefined;

    const minor = `${v.major}.${v.minor}`;
    if (CREDENTIALED_NEXT_MINORS.includes(minor)) {
        if (hits.length === 0) {
            return [
                mk(
                    ID,
                    TITLE,
                    "pass",
                    `Next.js ${installed} is on a credentialed minor (${credentialed})`,
                ),
            ];
        }
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `Next.js ${installed} is on a credentialed minor (${credentialed}), but the credential does not make it safe to run${advisoryNote}`,
                upgradeHint,
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
                `Next.js ${installed} is outside the range knext declares (${NEXT_PEER_RANGE}); credentialed minors: ${credentialed}${advisoryNote}`,
                `install a Next.js version inside ${NEXT_PEER_RANGE}: ${recommended}`,
            ),
        ];
    }
    const forced = SECURITY_FORCED_NEXT_MINORS.find((f) => f.minor === minor);
    if (forced !== undefined) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `Next.js ${installed} is on ${minor}, which knext supports but the official compatibility results do not cover yet (credentialed: ${credentialed}). No release of the credentialed minor fixes ${forced.advisories.join(", ")}, so ${minor} is the recommended line until the credential moves${advisoryNote}`,
                upgradeHint,
            ),
        ];
    }
    return [
        mk(
            ID,
            TITLE,
            "warn",
            `Next.js ${installed} is inside the declared range (${NEXT_PEER_RANGE}) but not a credentialed minor (${credentialed}); it works, but the official compatibility results do not cover it${advisoryNote}`,
            upgradeHint ?? `use ${recommended}, the line knext recommends`,
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
