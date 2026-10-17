#!/usr/bin/env node
/**
 * Mutation proof for `knext add function --lang go` (the Go scaffold):
 * what is copied from templates/go, which template is used, the module-path
 * check, rollback on a failed step, and the packaging that ships the template.
 *
 * One guard, `add-function-go.test.ts`; each mutation removes ONE behaviour and
 * requires it to go red:
 *
 *   X1  the exclude list is ignored (excluded files are copied)
 *   X2  a template file is silently dropped (not on the exclude list)
 *   X3  an unreviewed entry is added to the exclude list
 *   X4  the module path is not substituted
 *   T1  turbo no longer declares the template as a build output (a cache hit
 *       would ship a tarball without it)
 *   T2  turbo no longer declares templates/go as a build input (an edit to the
 *       template would never invalidate the cache)
 *   S1  a source run prefers the stale, gitignored package copy
 *   M1  "." and ".." are accepted as --module path elements
 *   R1  a failed step is no longer rolled back
 *
 * Verdicts are by EXIT CODE only (the shared driver,
 * `scripts/lib/guard-prover.mjs`): every anchor occurs exactly once (preflight
 * first), the baseline must be green, a canary must go red before any green is
 * trusted, and every restore is content-verified.
 *
 * The guard runs `go` (the scaffold generates the function's Go code and the
 * scaffold is built and tested), so the nightly lane needs Go: it already
 * installs it for the operator's metric-contract prover, and the template's
 * newer go.mod is satisfied by GOTOOLCHAIN=auto.
 *
 * Usage:  node scripts/mutation-prove-2479-go-scaffold.mjs
 * Exit 0 = every row behaved as required; 1 = one did not or the run was partial.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// JSON has no comments: the residue marker rides in as a key of its own.
const JSON_MARK = `"//${MUTATION_MARKER}": "mutated",`;

const MUTATIONS = [
  {
    id: 'X1',
    subject: 'scaffold',
    claim: 'the exclude list is ignored: excluded template files are copied',
    anchor: 'return walkFiles(dir, GO_TEMPLATE_EXCLUDES);',
    replacement: 'return walkFiles(dir);',
  },
  {
    id: 'X2',
    subject: 'scaffold',
    claim: 'a template file is silently dropped without being on the exclude list',
    anchor: 'return walkFiles(dir, GO_TEMPLATE_EXCLUDES);',
    replacement: "return walkFiles(dir, GO_TEMPLATE_EXCLUDES).filter((f) => f !== 'main.go');",
  },
  {
    id: 'X3',
    subject: 'scaffold',
    claim: 'an unreviewed entry is added to the exclude list',
    anchor: "  { path: 'proto', why: 'written from the function contract, not copied' },",
    replacement:
      "  { path: 'Dockerfile', why: 'x' },\n  { path: 'proto', why: 'written from the function contract, not copied' },",
  },
  {
    id: 'X4',
    subject: 'scaffold',
    claim: 'the module path is not substituted',
    anchor: "'example.com/function': s.module,",
    replacement: "'example.com/function-unused': s.module,",
  },
  {
    id: 'T1',
    subject: 'turbo',
    claim: 'turbo does not cache the template as a build output',
    anchor: '"outputs": ["$TURBO_EXTENDS$", "templates/**"]',
    replacement: `"outputs": ["$TURBO_EXTENDS$"], ${JSON_MARK.replace(/,$/, '')}`,
  },
  {
    id: 'T2',
    subject: 'turbo',
    claim: 'turbo does not hash templates/go as a build input',
    anchor: '"$TURBO_ROOT$/templates/go/**",',
    replacement: `"//${MUTATION_MARKER}",`,
  },
  {
    id: 'S1',
    subject: 'template',
    claim: 'a source run prefers the stale package copy of the template',
    anchor: "const fromSource = moduleFile.endsWith('.ts');",
    replacement: 'const fromSource = false;',
  },
  {
    id: 'M1',
    subject: 'scaffold',
    claim: '"." and ".." are accepted as --module path elements',
    anchor: "if (module.split('/').some((el) => el === '.' || el === '..')) {",
    replacement: 'if (false) {',
  },
  {
    id: 'R1',
    subject: 'add',
    claim: 'a failed step is no longer rolled back',
    anchor: 'for (const u of undo.reverse()) {',
    replacement: 'for (const u of [] as Array<() => void>) {',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/add-function-go.test.ts',
  subjects: {
    scaffold: 'packages/grpc/src/scaffold-go.ts',
    template: 'packages/grpc/src/scaffold-template.ts',
    add: 'packages/grpc/src/add-function.ts',
    turbo: 'packages/grpc/turbo.json',
  },
});

console.log('=== mutation proof: knext add function --lang go ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'add',
  anchor: "if (!existsSync(join(cwd, 'buf.yaml'))) write('buf.yaml', BUF_YAML);",
  replacement: ';',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
