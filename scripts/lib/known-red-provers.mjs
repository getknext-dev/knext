/**
 * Provers that are RED TODAY and tracked in an open issue (#2499).
 *
 * The first full run of the sharded lane found real, reproducible reds that have
 * nothing to do with the lane. They stay red until their owners fix the GUARD (or
 * re-anchor the prover); this list exists for one reason: so that the alert issue
 * can say "these four are known" and a NEW red stands out instead of drowning in
 * the same four lines every night.
 *
 * WHAT THIS LIST MUST NEVER DO, and `tests/mutation-prover-lane-sharding.test.ts`
 * asserts each of these:
 *   - it does not skip a prover, change a prover's declared count, or make the
 *     aggregate pass: a known-red finding still fails the lane;
 *   - it is read ONLY to label findings in the alert text.
 *
 * When an issue is fixed and closed, delete its entry here in the same PR; a
 * stale entry would mislabel a regression of that prover as "known".
 */

export const KNOWN_RED_PROVERS = Object.freeze([
  {
    prover: 'scripts/mutation-prove-2171-redis-prefix-isolation.mjs',
    issue: 2517,
    why: 'mutation D03 survives: the doctor guard is decoration for that rule',
    // Exists on integration/v2 only; the list is identical on main, where it is inert.
    onlyOn: 'integration/v2',
  },
  {
    prover: 'scripts/mutation-prove-anonymous-install.mjs',
    issue: 2518,
    why: 'anchor rot: preflight refuses to start',
  },
  {
    prover: 'scripts/mutation-prove-compat-fail-on-red-teeth.mjs',
    issue: 2519,
    why: 'anchor rot: preflight refuses to start',
  },
  {
    prover: 'scripts/mutation-prove-compat-step-level-disarms.mjs',
    issue: 2520,
    why: 'two rows prove a decorative guard',
  },
]);

/**
 * Split aggregate findings into KNOWN (names a listed prover) and FRESH.
 * A finding that names no prover (a missing leg, a sha mismatch, an empty plan)
 * is always fresh: only a specific, listed prover can be "known".
 *
 * @param {string[]} findings
 * @param {ReadonlyArray<{ prover: string, issue: number }>} list
 */
export function classifyFindings(findings, list = KNOWN_RED_PROVERS) {
  const known = [];
  const fresh = [];
  for (const finding of findings) {
    const hit = list.find((k) => finding.includes(k.prover));
    if (hit) known.push({ finding, issue: hit.issue });
    else fresh.push(finding);
  }
  return { known, fresh };
}

/** Markdown for the alert: the standing list, so a reader can tell new from known. */
export function knownRedMarkdown(list = KNOWN_RED_PROVERS) {
  const lines = list.map((k) => `- #${k.issue} \`${k.prover}\` — ${k.why}`);
  return [
    'Known red, tracked elsewhere (these still FAIL the lane; they are only labelled here so a new red stands out):',
    '',
    ...lines,
  ].join('\n');
}
