/**
 * native-integrity-policy.mjs — the ONE place the manifest-absence exception is
 * declared, with a clock on it (S2).
 *
 * WHAT IS EXCUSED. `sharp-addon-dlopen.mjs`'s `verifyAgainstManifest` warns and
 * loads when there is no `.integrity.json` beside the addon, instead of
 * refusing. It has to: an image built before native-tree integrity pinning
 * landed has no manifest, and failing closed on absence would turn a security
 * improvement into a fleet outage. A MISMATCH has always been fatal; only
 * ABSENCE is permissive.
 *
 * WHY IT NEEDS A DATE. The exception is bounded by construction today — both
 * Dockerfiles fail the build without a manifest, so no image knext ships can
 * reach the permissive branch. But "bounded by construction" is a property of
 * two Dockerfiles, not of the runtime, and it is exactly the ADR-0044 shape this
 * repo has already been bitten by: a deferral with no expiry and no fail-closed
 * switch stops being a deferral and becomes the design. So it gets both.
 *
 * THE SWITCH. `KNEXT_REQUIRE_NATIVE_INTEGRITY=1` makes absence a refusal. An
 * operator who knows every image in their fleet is current can turn the
 * exception off today, without waiting for the date.
 *
 * WHY THE EXPIRY IS ENFORCED IN A TEST AND NOT IN THE SHIM. A wall-clock branch
 * inside the runtime would brick running pods at midnight on the expiry date —
 * converting a documented debt into an outage, which is the failure this whole
 * exception exists to avoid. The clock therefore reds CI
 * (`tests/native-integrity-absence-exception.test.ts`) and forces the decision
 * to be made by a human, on a working day, with a rollout.
 */

import { activeExemptions } from './dated-exemptions.mjs';

/** The subject key. One exception, named, so a second one cannot arrive unnoticed. */
export const NATIVE_INTEGRITY_ABSENCE = 'sharp-addon-dlopen:manifest-absence';

export const NATIVE_INTEGRITY_EXEMPTIONS = Object.freeze([
  Object.freeze({
    exception: NATIVE_INTEGRITY_ABSENCE,
    justification:
      'A pre-pinning image has no .integrity.json, so refusing on ABSENCE would brick a fleet ' +
      'rather than harden it; a MISMATCH is already fatal. Re-raise condition: flip the default ' +
      'to fail-closed once no supported image predates native-tree pinning — i.e. at Tier-A exit ' +
      'or v1.0, whichever is first. KNEXT_REQUIRE_NATIVE_INTEGRITY=1 turns it off today.',
    added: '2026-09-04',
    expires: '2026-12-01',
  }),
]);

/**
 * The exceptions still live at `now`. Empty means the clock has run out and the
 * default must flip — the caller asserts that, because a shared reader cannot
 * enforce what its callers do with a smaller set.
 *
 * @param {Date} [now]
 * @returns {Set<string>}
 */
export function activeNativeIntegrityExemptions(now = new Date()) {
  return activeExemptions(NATIVE_INTEGRITY_EXEMPTIONS, { field: 'exception', now });
}
