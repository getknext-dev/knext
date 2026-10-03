#!/usr/bin/env node
/**
 * Mutation proof for the R1 amendment to the bundled vinext#3424 patch
 * (vinext-bun-failure-triage-2026-10-03.md, R1).
 *
 * WHAT THIS GUARDS. `vinext-3424-nitro-rsc-bundle-deps.patch` sets a blanket
 * `resolve: { noExternal: true }` for the RSC environment under Nitro. The
 * un-amended patch (as shipped in 1.3.0-rc.1) had no `external` alongside it,
 * which swept Next's default server-external list — including sqlite3's
 * `bindings` helper and typescript — into the compiled executable, regressing
 * the turbopack-reports and twoslash deploy-test fixtures. The fix carries
 * `external: [...userSsrExternal]` next to `noExternal: true` so those
 * packages stay external under Nitro too.
 *
 * The claim proved, which fails silently if wrong: reverting the patch
 * template back to the un-amended (rc.1) hunk — the EXACT regression this fix
 * exists to undo — reds `vinext-patches.test.ts`. A negative control (reword
 * the amendment's own explanatory prose, which no assertion reads) stays
 * green, so the red above is explained by the code, not by a spec asserting
 * on prose.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline;
 * a canary red first; anchors exactly once or abort; clean tree between
 * mutations; never perl.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/vinext-patches.test.ts';
const PATCH = 'packages/kn-next/templates/vinext-patches/vinext-3424-nitro-rsc-bundle-deps.patch';

// The FIXED (amended) hunk line, as it stands on disk today.
const FIXED_LINE =
  '+\t\t\t\t\t\t\t...hasNitroPlugin && !hasCloudflarePlugin && userSsrExternal !== true ? { resolve: { noExternal: true, external: [...userSsrExternal] } } : nitroDevEnvironmentResolve,\n';

// The UN-AMENDED (rc.1-shipped, regression-carrying) hunk line.
const REGRESSED_LINE =
  '+\t\t\t\t\t\t\t...hasNitroPlugin && !hasCloudflarePlugin && userSsrExternal !== true ? { resolve: { noExternal: true } } : nitroDevEnvironmentResolve,\n';

// A sentence from the amendment's own header prose, unique in the file and
// read by no assertion (the header tests only require the upstream link and
// the retirement-condition phrase, both left untouched below).
const PROSE_ANCHOR =
  'alongside `noExternal: true` keeps those packages external under Nitro too, matching the\n';
const PROSE_REWORD =
  'alongside `noExternal: true` keeps those specific packages external under Nitro too, matching the\n';

const MUTATIONS = [
  {
    id: 'V1',
    expect: 'red',
    claim:
      'reverting the patch template to the un-amended (rc.1-shipped) hunk reintroduces the exact ' +
      'regression this fix undoes — the patched dist loses its `external:` carve-out, so both the ' +
      'updated "ported hunks are present" assertion and the dedicated behavioural test (which ' +
      'evaluates the ternary extracted from the patched dist) fail',
    subject: 'patch',
    anchor: FIXED_LINE,
    replacement: REGRESSED_LINE,
    options: { commentPrefix: '//' },
  },
  {
    id: 'V2',
    expect: 'green',
    claim:
      'NEGATIVE CONTROL — rewording the amendment header prose (read by no assertion: the header ' +
      'tests only require the upstream PR link and the retirement-condition phrase, both left ' +
      'untouched) stays green, so the red above is explained by the code, not by a spec asserting ' +
      'on prose',
    subject: 'patch',
    anchor: PROSE_ANCHOR,
    replacement: PROSE_REWORD,
    options: { commentPrefix: '//' },
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    patch: PATCH,
    spec: SPEC,
  },
});

console.log(`=== mutation proof: ${SPEC} (vinext#3424 R1 amendment) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

prover.proveCanSeeRed({
  subject: 'spec',
  anchor:
    'expect(index).toContain(\n' +
    '            "...hasNitroPlugin && !hasCloudflarePlugin && userSsrExternal !== true ? { resolve: { noExternal: true, external: [...userSsrExternal] } } : nitroDevEnvironmentResolve,",\n' +
    '        );',
  replacement:
    'expect(index).toContain(\n' +
    '            "this string can never occur in the patched dist // KNEXT-MUTATION",\n' +
    '        );',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
