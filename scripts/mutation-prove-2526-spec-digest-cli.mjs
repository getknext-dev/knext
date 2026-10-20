#!/usr/bin/env node
/**
 * Mutation proof for the CLI's half of the zone spec pin (#2526, ADR-0004
 * Amendment 4): `packages/grpc/src/spec-digest.ts`, the twin of the operator's
 * canonical form, and the digest `knext deploy function` prints.
 *
 * The operator half (the comparison, each hashed member, the Bound condition, the
 * field coverage guard) is proved by rows X01-X23 of
 * scripts/mutation-prove-2052-backendservice.mjs, which grades Go. This prover
 * grades the TypeScript side with two guards, no cluster needed:
 *
 *   - `spec-digest.test.ts` recomputes the shared vectors
 *     (packages/kn-next-operator/internal/controller/testdata/
 *     backend-spec-digest-vectors.json) the Go operator recomputes too. A row
 *     here that breaks the canonical form on the CLI side alone must turn it red,
 *     or a CLI that prints a digest the operator will never match would pass.
 *     Each row breaks ONE rule: key order, a hashed member, the domain line, the
 *     byte length, the dropping of zero values, list order, the refusal of
 *     floats, of a lone surrogate, of a spec with no image.
 *   - `deploy-function.test.ts` asserts what `knext deploy function` prints: the
 *     digest of the spec it applied (not of something else), the spec-pin entry,
 *     and the weaker image-only entry.
 *
 * Verdicts are by EXIT CODE (the shared driver, `scripts/lib/guard-prover.mjs`):
 * every anchor must occur exactly once (preflight first), each baseline must be
 * green, a canary must go red before any green is trusted, a mutation that leaves
 * its subject unparseable aborts rather than counting as a kill, and every
 * restore is content-verified.
 *
 * Usage:  node scripts/mutation-prove-2526-spec-digest-cli.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST_LIB = 'packages/grpc/src/spec-digest.ts';
const DIGEST_SPEC = 'packages/grpc/src/__tests__/spec-digest.test.ts';
const DEPLOY_LIB = 'packages/grpc/src/deploy-function.ts';
const DEPLOY_SPEC = 'packages/grpc/src/__tests__/deploy-function.test.ts';

// A mutation must leave its subject parseable: a red for a syntax error is a red
// for the wrong reason.
const validateTs = (text) => {
  const out = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const first = out.diagnostics?.[0];
  return first ? `TS: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}` : undefined;
};

const DIGEST = [
  {
    id: 'T01',
    subject: 'digest',
    claim: 'object keys are not sorted: the digest depends on the order they were written in',
    anchor: "Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),",
    replacement: '0,',
  },
  {
    id: 'T02',
    subject: 'digest',
    claim: 'env is not hashed: the printed digest ignores the settings it should bind',
    anchor:
      "export const BACKEND_SPEC_PINNED_FIELDS: readonly string[] = ['image', 'env', 'envFrom', 'volumes'];",
    replacement:
      "export const BACKEND_SPEC_PINNED_FIELDS: readonly string[] = ['image', 'envFrom', 'volumes'];",
  },
  {
    id: 'T03',
    subject: 'digest',
    claim: 'the domain line is dropped from the preimage',
    anchor: "export const SPEC_DIGEST_DOMAIN = 'knext/backendservice-spec/v1\\n';",
    replacement: "export const SPEC_DIGEST_DOMAIN = '';",
  },
  {
    id: 'T04',
    subject: 'digest',
    claim: 'string length is counted in UTF-16 units, not UTF-8 bytes',
    anchor: 'return `s${bytes.length}:${s}`;',
    replacement: 'return `s${s.length}:${s}`;',
  },
  {
    id: 'T05',
    subject: 'digest',
    claim: 'empty strings are kept: absent and empty hash differently from the operator',
    anchor: "if (typeof v === 'string') return [v, v === ''];",
    replacement: "if (typeof v === 'string') return [v, false];",
  },
  {
    id: 'T06',
    subject: 'digest',
    claim: 'list order is not part of the digest: a reordered env passes',
    anchor: "if (Array.isArray(v)) return `l${v.map(encode).join('')}e`;",
    replacement: "if (Array.isArray(v)) return `l${v.map(encode).sort().join('')}e`;",
  },
  {
    id: 'T07',
    subject: 'digest',
    claim: 'a float is encoded instead of refused: the two sides could disagree on its text',
    anchor: 'if (!Number.isSafeInteger(v)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'T08',
    subject: 'digest',
    claim: 'a lone surrogate is hashed as U+FFFD instead of refused',
    anchor: "if (bytes.toString('utf8') !== s) {",
    replacement: 'if (false) {',
  },
  {
    id: 'T09',
    subject: 'digest',
    claim: 'a spec with no image still gets a digest',
    anchor: "if (typeof spec.image !== 'string' || spec.image === '') {",
    replacement: 'if (false) {',
  },
];

const DEPLOY = [
  {
    id: 'D01',
    subject: 'deploy',
    claim: 'knext deploy function prints a digest of something other than the spec it applied',
    anchor: 'const specDigest = backendSpecDigest(cr.spec);',
    replacement:
      'const specDigest = backendSpecDigest({ ...cr.spec, image: `${cr.spec.image}x` });',
  },
  {
    id: 'D02',
    subject: 'deploy',
    claim: 'the printed spec-pin entry carries the image pin instead of the spec digest',
    anchor: "`  { name: '${name}', specDigest: '${specDigest}' }\\n` +",
    replacement: "`  { name: '${name}', specDigest: '${pin}' }\\n` +",
  },
  {
    id: 'D03',
    subject: 'deploy',
    claim: 'the weaker image-only entry is no longer printed',
    anchor: "`  { name: '${name}', image: '${pin}' }\\n` +",
    replacement: "'' +",
  },
];

for (const m of [...DIGEST, ...DEPLOY]) m.validate = validateTs;

const digest = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: DIGEST_SPEC,
  subjects: { digest: DIGEST_LIB },
});
const deploy = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: DEPLOY_SPEC,
  subjects: { deploy: DEPLOY_LIB },
});

digest.preflight(DIGEST);
deploy.preflight(DEPLOY);
declareMutations(DIGEST.length + DEPLOY.length);

console.log("\n=== the CLI's canonical form is the operator's, to the byte ===");
digest.baseline();
digest.proveCanSeeRed({
  subject: 'digest',
  anchor: "export const SPEC_DIGEST_DOMAIN = 'knext/backendservice-spec/v1\\n';",
  replacement: "export const SPEC_DIGEST_DOMAIN = 'knext/backendservice-spec/v2\\n';",
});
for (const m of DIGEST) {
  digest.run({ ...m, expect: 'red' });
  recordMutation();
}
digest.finish(DIGEST.length);

console.log('\n=== what `knext deploy function` prints ===');
deploy.baseline();
deploy.proveCanSeeRed({
  subject: 'deploy',
  anchor: 'const specDigest = backendSpecDigest(cr.spec);',
  replacement: "const specDigest = 'sha256:0';",
});
for (const m of DEPLOY) {
  deploy.run({ ...m, expect: 'red' });
  recordMutation();
}
deploy.finish(DEPLOY.length);
