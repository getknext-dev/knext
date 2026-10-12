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
 * Exact `next` versions the cache-handler spec matrix installs, one per
 * admitted minor (`.github/workflows/next-minor-matrix.yml`, which reads this
 * list through `scripts/next-minor-matrix.mjs` - never a second copy).
 *
 * The first entry is the credential pin (it must equal the `next` devDependency
 * of `packages/kn-next`); the others are the newest published patch of each
 * further minor `NEXT_PEER_RANGE` admits. Widening the range without adding the
 * minor here, or the reverse, fails `tests/next-minor-matrix.test.ts`.
 */
export const NEXT_MATRIX_VERSIONS: readonly string[] = ["16.3.8", "16.4.0"];
