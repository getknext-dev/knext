/**
 * Published Next.js security advisories that `knext doctor` FAILs on.
 *
 * Only CRITICAL/HIGH advisories with a published fix belong here: a FAIL row
 * must always come with a version to upgrade to. Each `ranges` entry is copied
 * from the GitHub advisory database record for that GHSA id
 * (`gh api /advisories/<id>`), one entry per affected release line, with the
 * advisory's own inclusive `<= lastAffected` bound and its
 * `first_patched_version` as `fixed`.
 *
 * Kept separate from `next-compat.ts`: that module is a compatibility policy
 * (which minors knext supports and has evidence for), this one is a security
 * floor. A minor can be supported and still have a vulnerable patch.
 */

export interface NextAdvisoryRange {
    /** First affected version (inclusive). */
    readonly introduced: string;
    /** Last affected version (inclusive), as the advisory states it. */
    readonly lastAffected: string;
    /** First patched version on this line. */
    readonly fixed: string;
}

export interface NextAdvisory {
    readonly id: string;
    readonly severity: "critical" | "high";
    readonly summary: string;
    readonly ranges: readonly NextAdvisoryRange[];
}

export const NEXT_ADVISORIES: readonly NextAdvisory[] = [
    {
        id: "GHSA-2464-fhr4-w9xw",
        severity: "critical",
        summary:
            "unauthenticated remote code execution in the Image Optimization API when SVG files are used",
        ranges: [
            { introduced: "10.0.0", lastAffected: "15.5.27", fixed: "15.5.28" },
            { introduced: "16.0.0", lastAffected: "16.4.0", fixed: "16.4.1" },
        ],
    },
    {
        id: "GHSA-673q-mjm6-r5xr",
        severity: "critical",
        summary:
            "unauthenticated remote code execution in 'use cache' functions returning typed arrays",
        ranges: [
            { introduced: "16.0.0", lastAffected: "16.4.0", fixed: "16.4.1" },
        ],
    },
    {
        id: "GHSA-p3m5-59mp-jv5r",
        severity: "high",
        summary: "denial of service in the App Router through Server Actions",
        ranges: [
            { introduced: "13.0.0", lastAffected: "15.5.27", fixed: "15.5.28" },
            { introduced: "16.0.0", lastAffected: "16.4.0", fixed: "16.4.1" },
        ],
    },
];

type Triple = [number, number, number];

function triple(raw: string): Triple | undefined {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function cmp(a: Triple, b: Triple): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/** One advisory that applies to a version, with the fix on that version's line. */
export interface NextAdvisoryHit {
    readonly id: string;
    readonly severity: NextAdvisory["severity"];
    readonly summary: string;
    readonly fixed: string;
}

/**
 * Whether `version` can be compared against the advisory ranges at all.
 * Prerelease suffixes are compared on their `X.Y.Z` core.
 */
export function isComparableNextVersion(version: string): boolean {
    return triple(version) !== undefined;
}

/**
 * Advisories for which NO release of the `major.minor` line `minor` is fixed:
 * every release of the line is inside the affected range and the fix ships on
 * a later minor. Such a minor must never be recommended to a user — doing so
 * tells them to downgrade into the advisory.
 */
export function minorWithoutFixedRelease(minor: string): string[] {
    const m = /^(\d+)\.(\d+)$/.exec(minor.trim());
    if (!m) return [];
    const [maj, min] = [Number(m[1]), Number(m[2])];
    const cmpMinor = (v: string): number => {
        const t = triple(v) as Triple;
        return t[0] !== maj ? t[0] - maj : t[1] - min;
    };
    const ids: string[] = [];
    for (const advisory of NEXT_ADVISORIES) {
        if (
            advisory.ranges.some(
                (r) =>
                    // affected from the line's first release (X.Y.0) ...
                    cmp(triple(r.introduced) as Triple, [maj, min, 0]) <= 0 &&
                    // ... through past its end, with the fix on a later minor.
                    cmpMinor(r.lastAffected) > 0 &&
                    cmpMinor(r.fixed) > 0,
            )
        ) {
            ids.push(advisory.id);
        }
    }
    return ids;
}

/** Every advisory in {@link NEXT_ADVISORIES} that affects `version`. */
export function nextAdvisoriesFor(version: string): NextAdvisoryHit[] {
    const v = triple(version);
    if (v === undefined) return [];
    const hits: NextAdvisoryHit[] = [];
    for (const advisory of NEXT_ADVISORIES) {
        for (const range of advisory.ranges) {
            const lo = triple(range.introduced) as Triple;
            const hi = triple(range.lastAffected) as Triple;
            if (cmp(v, lo) >= 0 && cmp(v, hi) <= 0) {
                hits.push({
                    id: advisory.id,
                    severity: advisory.severity,
                    summary: advisory.summary,
                    fixed: range.fixed,
                });
                break;
            }
        }
    }
    return hits;
}
