/**
 * e2e-round-paths.mjs — path scoping for the CI aggregator (issue #1197 / T1).
 *
 * The round gates only changes that can actually alter what file-manager builds,
 * serves or ships. Scoping happens HERE, at the aggregator, via a merge-base
 * `git diff --name-only` — NEVER by adding `paths:` to `ci.yml`. #673 is on the
 * record: a `paths:` filter on `ci.yml` took stacked PRs (this repo's normal
 * working mode) from all jobs to zero. So a docs/CI/script-only PR reports "N/A"
 * GREEN with the reason printed, exactly as `escalation-triggers` does.
 *
 * Each entry is a predicate over a repo-relative path. A path is app-affecting if
 * ANY predicate matches. The list mirrors the runtime/adapter/build/operator path
 * classes named in the design; keep it in sync with the workflow.md proposal.
 */

/** @type {ReadonlyArray<(p: string) => boolean>} */
export const APP_AFFECTING = Object.freeze([
  // the runtime adapters + the build/generator surface the app compiles through
  (p) => p.startsWith('packages/kn-next/src/adapters/'),
  (p) => p.startsWith('packages/kn-next/src/cli/build'),
  (p) => p.startsWith('packages/kn-next/src/generators/'),
  (p) => p === 'packages/kn-next/src/config.ts',
  // the operator that reconciles the running system
  (p) => p.startsWith('packages/kn-next-operator/'),
  // the reference app itself + the app template
  (p) => p.startsWith('apps/file-manager/'),
  (p) => p.startsWith('templates/app/'),
  // any Dockerfile (prod image leg) — matches `Dockerfile`, `Dockerfile.foo`,
  // and nested `foo/Dockerfile`
  (p) => /(^|\/)Dockerfile[^/]*$/.test(p),
  // runtime entrypoints / contract / compile glue, wherever they live
  (p) => /(^|\/)[^/]*-entry\.mjs$/.test(p),
  (p) => /(^|\/)runtime-contract\.mjs$/.test(p),
  (p) => /(^|\/)node-server\.ts$/.test(p),
  (p) => /(^|\/)vinext-compile[^/]*$/.test(p),
]);

/**
 * Is this path app-affecting?
 * @param {string} p repo-relative path
 * @returns {boolean}
 */
export function isAppAffecting(p) {
  return typeof p === 'string' && p.length > 0 && APP_AFFECTING.some((f) => f(p));
}

/**
 * The subset of `files` that are app-affecting. Empty ⇒ the round is N/A.
 * @param {ReadonlyArray<string>} files
 * @returns {string[]}
 */
export function appAffectingFiles(files) {
  return (files || []).filter(isAppAffecting);
}
