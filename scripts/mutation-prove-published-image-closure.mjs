#!/usr/bin/env node
/**
 * Mutation proof for #903's published-image closure gate (sprint 2, lane G — G2).
 *
 * WHAT #903 CLAIMED, AND WHY IT NEEDS PROVING
 * -------------------------------------------
 * Before #903, the image the project publishes was scanned for OS packages while
 * the ~560-component JS closure it actually ships was not — and the SBOM
 * `cosign attest`ed onto the pushed digest described the wrong thing. #903 made
 * three claims, all of them about a WORKFLOW, which is the worst case for
 * review-by-inspection: YAML compiles no matter what it says.
 *
 *   1. every job that PUBLISHES a vinext image audits THAT APP's closure, and
 *      does so BEFORE the image is built — an audit that runs after the push
 *      cannot stop anything;
 *   2. the closure SBOM is what gets attested, as CycloneDX — the format the
 *      audit emits;
 *   3. the app set is DISCOVERED from manifests, never listed, so an app that
 *      starts building on vinext is covered without anyone remembering.
 *
 * This is a `security.md` supply-chain invariant, so "the guard exists" is not
 * the bar. Each of the three is mutated here against the real workflow.
 *
 * WHAT THIS PROVER DELIBERATELY DOES NOT COVER, said plainly: the guard's
 * in-memory mutations (`:96`, `:121`, `:145`) already exercise the `needs`-closure
 * and ordering logic against synthetic YAML, and are better placed than a
 * process-level prover to do it. What only a prover can add is whether the guard
 * still fires against the REAL `supply-chain.yml` — which is what every mutation
 * below does.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 * `scripts/lib/guard-prover.mjs` enforces all of it.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every workflow mutation must leave PARSEABLE YAML.
 *
 * Not paranoia — round 1 of this prover had a negative control red because the
 * harness's residue marker landed at column zero inside a `run: |` block scalar
 * and ended it. The four reds beside it looked like proof and would have been
 * accepted; only the negative control said otherwise. So validity is asserted
 * for every mutation, red and green alike, and a mutation that breaks the YAML
 * ABORTS rather than grading.
 */
const yamlStillParses = (text) => {
  try {
    parseYaml(text);
    return undefined;
  } catch (err) {
    return `the mutated workflow is not valid YAML: ${err.message}`;
  }
};
const SPEC = 'tests/published-image-closure-gate.test.ts';

const AUDIT_STEP = 'run: node scripts/precompile-closure-audit.mjs --app apps/file-manager';
const CLOSURE_ATTEST =
  'cosign attest --yes --predicate sbom/app-closure.cdx.json --type cyclonedx "${IMAGE}@${DIGEST}"';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the closure audit is scoped to the WRONG app — the publish job audits a closure it does ' +
      'not ship, which is a green scan of something nobody runs',
    subject: 'workflow',
    validate: yamlStillParses,
    anchor: AUDIT_STEP,
    replacement: 'run: node scripts/precompile-closure-audit.mjs --closure examples/bun-exec',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the closure audit is REMOVED from the publish lane entirely — the ~560-component JS ' +
      'closure the image ships goes unscanned while the OS-package scan still reports green',
    subject: 'workflow',
    validate: yamlStillParses,
    anchor: `        ${AUDIT_STEP}\n`,
    replacement: '        # the closure audit, removed by the mutation\n',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the attestation predicate reverts to the image SBOM — the signed statement on the pushed ' +
      'digest describes the OS layer, not the closure, which is the exact defect #903 filed',
    subject: 'workflow',
    validate: yamlStillParses,
    anchor: CLOSURE_ATTEST,
    replacement:
      'cosign attest --yes --predicate sbom.spdx.json --type cyclonedx "${IMAGE}@${DIGEST}"',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the predicate keeps the closure SBOM but is attested as SPDX — the wrong TYPE for the ' +
      'bytes, so a verifier asking for the CycloneDX closure finds nothing and reads it as absent',
    subject: 'workflow',
    validate: yamlStillParses,
    anchor: CLOSURE_ATTEST,
    replacement:
      'cosign attest --yes --predicate sbom/app-closure.cdx.json --type spdxjson "${IMAGE}@${DIGEST}"',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'the app set is ENUMERATED instead of discovered — the guard passes today and misses the ' +
      'next app to build on vinext, which is the failure "scan, do not enumerate" names',
    subject: 'scanHelper',
    anchor:
      'export function vinextAppDirs(repoRoot: string): string[] {\n  const dirs: string[] = [];',
    replacement:
      'export function vinextAppDirs(repoRoot: string): string[] {\n' +
      "  return ['apps/file-manager'];\n" +
      '  // biome-ignore lint/correctness/noUnreachable: mutation\n' +
      '  const dirs: string[] = [];',
  },
];

/**
 * NEGATIVE CONTROL. The image-level SPDX attestation is a SEPARATE, legitimate
 * statement that #903 kept — it is honestly labelled as the OS layer. Reordering
 * it must leave the guard GREEN.
 *
 * This pins the guard's scope: it must assert that the CLOSURE is attested, not
 * that the workflow's cosign block is frozen. A guard that reddened on any
 * cosign edit would be turned off the first time someone added a third
 * attestation.
 */
const NEGATIVE = {
  id: 'M6',
  expect: 'green',
  claim: 'the unrelated image-level SPDX attest gains a comment — the guard is not a YAML freeze',
  subject: 'workflow',
  validate: yamlStillParses,
  anchor: 'cosign attest --yes --predicate sbom.spdx.json --type spdxjson "${IMAGE}@${DIGEST}"',
  replacement:
    'cosign attest --yes --predicate sbom.spdx.json --type spdxjson "${IMAGE}@${DIGEST}" ' +
    '# the OS layer, kept and honestly labelled (negative control)',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    workflow: '.github/workflows/supply-chain.yml',
    scanHelper: 'tests/helpers/vinext-artifact-scan.ts',
  },
});

console.log(`=== mutation proof: ${SPEC} (#903 published-image closure) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary points the audit at a path that does not exist. If the guard does
// not notice the publish lane auditing nothing, no green below is worth reading.
prover.proveCanSeeRed({
  subject: 'workflow',
  anchor: AUDIT_STEP,
  replacement: 'run: node scripts/precompile-closure-audit.mjs --app apps/does-not-exist',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
