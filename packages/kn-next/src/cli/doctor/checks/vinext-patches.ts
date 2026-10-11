/**
 * vinext version drift — LOCAL and read-only, so it runs even when the cluster
 * is unreachable.
 *
 * WHY THIS EXISTS: knext bundles fixes for vinext that were validated against
 * exactly ONE vinext version (the patch manifest's). With any other version
 * installed `knext build` skips every fix and carries on — a user who
 * scaffolded on an older vinext and then upgraded `@getknext/core` ships an app
 * without the image-optimizer fix, the 404 fix and the rest, and the published
 * compatibility results no longer describe their build. Nothing said so.
 *
 * Severity follows what is known:
 *   - OLDER than the validated version -> FAIL: the fixes are certainly missing.
 *   - NEWER -> WARN: the release may already carry them upstream (knext drops a
 *     fix once a vinext release includes it), so it is not provably wrong.
 *   - not a version number -> WARN: cannot be compared, so say so.
 * No vinext installed -> no row at all, which keeps every non-vinext app's
 * report byte-identical to before this check existed.
 */

import {
    loadVinextPatchManifest,
    VINEXT_PATCHES_ENV,
    vinextPatchesDisabled,
    vinextPatchesStrict,
} from "../../vinext-patches";
import { parseSemver, type Semver } from "../operator-version";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

const ID = "vinext-patches";
const TITLE = "vinext matches knext's bundled fixes";

/** Negative when `a` < `b`. A prerelease sorts before its release. */
function compareSemver(a: Semver, b: Semver): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    if (a.prerelease === b.prerelease) return 0;
    if (a.prerelease === undefined) return 1;
    if (b.prerelease === undefined) return -1;
    return a.prerelease < b.prerelease ? -1 : 1;
}

export function vinextPatchesCheck(ctx: CheckContext): CheckResult[] {
    // Deliberately NOT defaulted here: like `cliVersion`, the real lookup is
    // supplied by `doctorMain`, so a `runDoctor` caller that injects its deps
    // (every golden/unit test) is never at the mercy of the machine's
    // node_modules.
    const installed = ctx.deps.readInstalledVinext?.();
    if (installed === undefined) return [];

    if (vinextPatchesDisabled()) {
        return [
            mk(
                ID,
                TITLE,
                "skip",
                `${VINEXT_PATCHES_ENV}=0 is set — knext's bundled vinext fixes are turned off on purpose (vinext ${installed} is installed)`,
            ),
        ];
    }

    const manifest = loadVinextPatchManifest();
    const expected = manifest.vinext;
    const count = manifest.patches.length;
    // Suggest strict only when it is not already the active mode.
    const strictHint = vinextPatchesStrict()
        ? ""
        : ` (set ${VINEXT_PATCHES_ENV}=strict to make \`knext build\` fail on this mismatch)`;
    const fix = `install vinext@${expected} and run \`knext vinext-patches\`${strictHint}`;

    if (installed === expected) {
        return [
            mk(
                ID,
                TITLE,
                "pass",
                `vinext ${installed} is the version knext's ${count} bundled fixes were validated against`,
            ),
        ];
    }

    const a = parseSemver(installed);
    const b = parseSemver(expected);
    if (a === undefined || b === undefined) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `vinext ${installed} is installed and cannot be compared with ${expected}, the version knext's ${count} bundled fixes were validated against — they are skipped for any other version`,
                fix,
            ),
        ];
    }

    if (compareSemver(a, b) < 0) {
        return [
            mk(
                ID,
                TITLE,
                "fail",
                `vinext ${installed} is older than ${expected}, the version knext's ${count} bundled fixes were validated against: none of them are applied, so the build lacks them (the Nitro image optimizer, 404s for unmatched asset requests, and more) and the published compatibility results do not cover it`,
                fix,
            ),
        ];
    }
    return [
        mk(
            ID,
            TITLE,
            "warn",
            `vinext ${installed} is newer than ${expected}, the version knext's ${count} bundled fixes were validated against: none of them are applied — fine if ${installed} already includes them, otherwise the build lacks them`,
            fix,
        ),
    ];
}
