/**
 * e2e-round-legs.mjs — the SINGLE SOURCE OF TRUTH for the file-manager e2e round.
 *
 * Issue #1197 / T1. The e2e round is not new coverage — the underlying checks
 * (compat-smoke, prod-image, drain/image) already gate every PR fail-closed. T1
 * gives them a NAME, an entry point, and one newly-wired leg (invalidation over
 * HTTP). This module is that name: both the local orchestrator (`e2e-round.mjs`)
 * and the CI aggregator's `needs:` list are derived from ONE registry here, and
 * `e2e-round.test.ts` reds if the two ever drift.
 *
 * Each leg declares:
 *   id      — stable identifier.
 *   title   — human label for the leg table.
 *   local   — does the local orchestrator RUN this leg? (build/compile/compat/
 *             invalidation/prod-image do; the drain + alpine image legs are
 *             CI-only — see G3: file-manager emits no standalone tree, so its
 *             drain/image proofs live in dedicated containerised CI jobs.)
 *   ciJob   — the ci.yml job that PROVES this leg on every PR, or null when the
 *             leg is subsumed by another job locally (build/compile happen inside
 *             the compat-smoke job; invalidation runs against the compat-smoke
 *             server and has no separate CI job — it is the round's added local
 *             fidelity). The set of non-null ciJob values MUST equal the
 *             aggregator's `needs:` list, verified by the sync guard.
 */

/** @typedef {{ id: string, title: string, local: boolean, ciJob: string|null }} Leg */

/** @type {ReadonlyArray<Leg>} */
export const LEGS = Object.freeze([
  Object.freeze({
    id: 'build',
    title: 'build chain (lib → db → core → file-manager)',
    local: true,
    ciJob: null, // built inside the compat-smoke job on CI
  }),
  Object.freeze({
    id: 'compile',
    title: 'compile single-executable (kn-next build / vinext)',
    local: true,
    ciJob: null, // compiled inside the compat-smoke job on CI
  }),
  Object.freeze({
    id: 'compat-smoke',
    title: 'serve + routes + ISR over real HTTP (checks a–k)',
    local: true,
    ciJob: 'compat-smoke',
  }),
  Object.freeze({
    id: 'invalidation-probe',
    title: 'ISR invalidate over HTTP (happy path + 401-without-token)',
    local: true,
    ciJob: null, // runs against the compat-smoke server; local-only added fidelity
  }),
  Object.freeze({
    id: 'prod-image',
    title: 'production image build + probe (next/image transcode)',
    local: true,
    ciJob: 'prod-image-optimization',
  }),
  Object.freeze({
    id: 'standalone-drain',
    title: 'SIGTERM drain under the operator server command (image)',
    local: false, // containerised CI job — not part of the local round
    ciJob: 'standalone-drain-bun-image',
  }),
  Object.freeze({
    id: 'bun-exec-alpine',
    title: 'compiled binary in a clean alpine container',
    local: false, // containerised CI job — not part of the local round
    ciJob: 'bun-exec-alpine-image',
  }),
]);

/** Legs the local orchestrator runs, in order. */
export const LOCAL_LEGS = LEGS.filter((l) => l.local);

/**
 * The exact `needs:` list the ci.yml aggregator MUST declare — every leg that is
 * proven by a dedicated CI job. Sorted for a stable set comparison.
 */
export const AGGREGATOR_NEEDS = Object.freeze(
  LEGS.map((l) => l.ciJob)
    .filter((j) => j !== null)
    .sort(),
);
