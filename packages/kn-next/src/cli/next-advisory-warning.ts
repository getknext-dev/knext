/**
 * Build/deploy-time WARNING for a Next.js with a published critical/high
 * advisory (#2594). `knext doctor` FAILs on the same table; this makes the
 * advisory visible to a user who never runs doctor. A warning, never a
 * refusal: the peer range still admits these versions, and the remedy (a
 * dependency bump) is the user's.
 */

import { nextAdvisoriesFor } from "../next-advisories";
import { readInstalledNextVersion } from "./doctor/checks/next-minor";

/** The warning text for an installed `next`, or undefined when there is none. */
export function nextAdvisoryWarning(
    version: string | undefined,
): string | undefined {
    if (version === undefined) return undefined;
    const hits = nextAdvisoriesFor(version);
    if (hits.length === 0) return undefined;
    const fixed = hits
        .map((h) => h.fixed)
        .reduce((a, b) => {
            const pa = a.split(".").map(Number);
            const pb = b.split(".").map(Number);
            for (let i = 0; i < 3; i++) {
                if (pa[i] !== pb[i]) return pa[i] > pb[i] ? a : b;
            }
            return a;
        });
    const list = hits.map((h) => `${h.id} (${h.severity})`).join(", ");
    return (
        `WARNING: this app resolves next@${version}, which is affected by published security advisories: ${list}. ` +
        `Upgrade next to ${fixed} or later and rebuild before deploying. ` +
        "`knext doctor` reports this as a FAIL."
    );
}

/**
 * Read the `next` the app at `cwd` resolves (the same lookup `knext doctor`
 * uses) and write the warning when it is affected. Never throws.
 */
export function warnOnVulnerableNext(
    cwd: string,
    write: (line: string) => void = (line) => {
        process.stderr.write(`${line}\n`);
    },
    readVersion: (cwd: string) => string | undefined = readInstalledNextVersion,
): void {
    let version: string | undefined;
    try {
        version = readVersion(cwd);
    } catch {
        return;
    }
    const warning = nextAdvisoryWarning(version);
    if (warning !== undefined) write(warning);
}
