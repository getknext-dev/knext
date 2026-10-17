#!/usr/bin/env node
/**
 * Mutation proof for the D3 spawn scan's treatment of shell scripts: spawning
 * a `.sh` file (directly, or through `bash`/`sh`) is unreadable, because the
 * script's body is not in the source being scanned; the one place the CLI
 * package does it (the Rust scaffold running the template's `codegen.sh`) is
 * an explicit, counted, exact allowlist entry that says why it is safe.
 *
 * One guard, `tests/cli-spawn-scan.test.ts`; each mutation removes ONE
 * behaviour and requires it to go red:
 *
 *   S1  a `.sh` program is no longer unreadable (the scan passes it)
 *   S2  the allowlist entry no longer matches its call site (stale, and the
 *       spawn is unreadable again)
 *   S3  the allowlist entry covers more than the one call site
 *   S4  the allowlist entry no longer says why it is safe
 *
 * Verdicts are by EXIT CODE only (the shared driver,
 * `scripts/lib/guard-prover.mjs`): every anchor occurs exactly once (preflight
 * first), the baseline must be green, a canary must go red before any green is
 * trusted, and every restore is content-verified. The tree must be clean (the
 * work committed) before it runs.
 *
 * Usage:  node scripts/mutation-prove-2489-spawn-scan-sh.mjs
 * Exit 0 = every row behaved as required; 1 = one did not or the run was partial.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  {
    id: 'S1',
    subject: 'scan',
    claim: 'a .sh program is no longer unreadable: the scan passes a script it cannot read',
    anchor: "if (/\\.sh$/.test(prog)) return 'unparseable';",
    replacement: "if (false) return 'unparseable';",
  },
  {
    id: 'S2',
    subject: 'scan',
    claim: 'the allowlist entry no longer matches its call site',
    anchor: 'arg: "\'./codegen.sh\'",',
    replacement: 'arg: "\'./gone.sh\'",',
  },
  {
    id: 'S3',
    subject: 'scan',
    claim: 'the allowlist entry covers a second .sh spawn in the same file',
    anchor: 'arg: "\'./codegen.sh\'",',
    replacement: 'arg: "\'./codegen.sh\'",\n    count: 2,',
  },
  {
    id: 'S4',
    subject: 'scan',
    claim: 'the allowlist entry no longer says why it is safe',
    anchor:
      "'pinned cargo install of protoc plugins; no kn/func. The script is templates/rust/codegen.sh ' +",
    replacement: "'The script is templates/rust/codegen.sh ' +",
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/cli-spawn-scan.test.ts',
  subjects: {
    scan: 'scripts/lib/cli-spawn-scan.mjs',
  },
});

console.log('=== mutation proof: the spawn scan and shell scripts ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'scan',
  anchor: "if (prog === 'kn') return 'kn is never run by the CLI';",
  replacement: ';',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
