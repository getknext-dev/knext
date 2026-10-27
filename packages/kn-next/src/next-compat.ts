/**
 * The Next.js compatibility policy for the 1.x line, in one place.
 *
 * - `NEXT_PEER_RANGE` is the `peerDependencies.next` range every publishable
 *   `@getknext/*` manifest declares. It is bounded: only minors that have
 *   compatibility evidence are admitted, and the bound is widened per minor as
 *   evidence lands.
 * - `CREDENTIALED_NEXT_MINORS` are the minors the official compatibility suite
 *   credential (and the CI e2e pins) cover. `knext doctor` warns on an
 *   installed minor outside this list.
 * - `SECURITY_FORCED_NEXT_MINORS` are minors the scaffold pins although the
 *   credential does not cover them, because a critical/high advisory has no fix
 *   on any credentialed minor (see `next-advisories.ts`).
 *
 * `tests/release-policy-matrix.test.ts` and `next-peer-policy.test.ts` assert
 * the manifests, the scaffold pins and the docs agree with these values.
 *
 * Retirement (maintainers): the 16.0-16.3 ISR build-scoping seed on 1.x goes
 * when the 1.x floor reaches 16.4 or 1.x reaches end of life; tracked in #2089.
 */

/** `peerDependencies.next` for every publishable package on the 1.x line. */
export const NEXT_PEER_RANGE = ">=16.0.0 <16.5.0";

/** `major.minor` lines the compatibility credential covers. */
export const CREDENTIALED_NEXT_MINORS: readonly string[] = ["16.3"];

/**
 * Minors the scaffold may pin WITHOUT the compatibility credential, each named
 * with the advisories that forced it. Legitimate only while a named advisory
 * has no fix on any credentialed minor — `next-peer-policy.test.ts` derives
 * that from the advisory table, so this entry goes red (and must be removed)
 * the moment a credentialed minor gets a patched release or the credential
 * moves to this minor. `knext doctor` still WARNs that the minor is not
 * credentialed: this list changes what the scaffold may ship, not what knext
 * claims.
 *
 * 16.4: GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr (critical, unauthenticated
 * RCE) and GHSA-p3m5-59mp-jv5r (high, DoS) affect every 16.x through 16.4.0
 * and are fixed only in 16.4.1; there is no 16.3.x patch.
 */
export const SECURITY_FORCED_NEXT_MINORS: readonly {
    readonly minor: string;
    readonly advisories: readonly string[];
}[] = [
    {
        minor: "16.4",
        advisories: [
            "GHSA-2464-fhr4-w9xw",
            "GHSA-673q-mjm6-r5xr",
            "GHSA-p3m5-59mp-jv5r",
        ],
    },
];

/**
 * Exact `next` versions the cache-handler spec matrix installs, one per
 * admitted minor (`.github/workflows/next-minor-matrix.yml`, which reads this
 * list through `scripts/next-minor-matrix.mjs` - never a second copy).
 *
 * The first entry is the credential pin (`credentialedNextRef` in
 * `.github/compat-credentialed-next-version.json`); the others are the newest
 * published patch of each further minor `NEXT_PEER_RANGE` admits. The `next`
 * devDependency of `packages/kn-next` must be one of them. Widening the range
 * without adding the minor here, or the reverse, fails
 * `tests/next-minor-matrix.test.ts`.
 */
export const NEXT_MATRIX_VERSIONS: readonly string[] = ["16.3.8", "16.4.3"];
