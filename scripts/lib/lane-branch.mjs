/**
 * The branch a test run belongs to. `PROVER_LANE_REF` wins: the nightly prover lane runs on a
 * schedule where `GITHUB_REF_NAME` is the workflow's ref (main) while the tree under proof is
 * another lane's checkout. Then the PR target, the pushed ref, and finally `fallback()`.
 *
 * @param {Record<string, string | undefined>} env
 * @param {() => string} fallback lazily reads the checked-out branch
 * @returns {string}
 */
export function laneBranchFromEnv(env, fallback) {
  return env.PROVER_LANE_REF || env.GITHUB_BASE_REF || env.GITHUB_REF_NAME || fallback();
}
