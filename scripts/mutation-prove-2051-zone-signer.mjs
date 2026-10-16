#!/usr/bin/env node
/**
 * Mutation proof for the zone-side identity token (#2051): the signer that
 * mints the per-call token, the generated glue that asks for it, and the
 * generate-time refusal of a zone that does not provide authorize().
 *
 * Five guards, five specs, one table each:
 *
 *   - `zone-signer.test.ts` — the signer: the user check (an AUTH_USER RPC
 *     without a sub, a request that does not say its auth), the 60 s lifetime,
 *     the kid (derivation and the current.kid match), re-reading a rotated
 *     key, Ed25519 only, the issuer and audience checks (cluster-local address,
 *     same namespace), the RPC path, identity only from the verified user, and
 *     nothing logged.
 *   - `zone-signer-glue.test.ts` — the generated glue against a real Connect
 *     verifier: each RPC's auth reaches its token request, and a request field
 *     never becomes the token's sub.
 *   - `glue-refusals.test.ts` — `knext generate` refuses an authorize module
 *     that does not export authorize by name.
 *   - `authorize-export.test.ts` — the lexical export check: a comment or a
 *     type-only export is not an export.
 *   - `zone-signer-gateway.test.ts` — Node and Bun gateway processes: a token
 *     that reaches the gateway's output is caught.
 *
 * Each mutation removes ONE behaviour and requires its spec to go red. Verdicts
 * are by EXIT CODE only (the shared driver, `scripts/lib/guard-prover.mjs`),
 * every anchor must occur exactly once (preflight first), each baseline must be
 * green, a canary must go red before any green is trusted, and every restore is
 * content-verified.
 *
 * Usage:  node scripts/mutation-prove-2051-zone-signer.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MINT_RETURN = '    return `${input}.${signature}`;';
const TTL = 'export const TOKEN_TTL_SECONDS = 60;';

// ── the signer ────────────────────────────────────────────────────────────
const SIGNER = [
  {
    id: 'S01',
    subject: 'signer',
    claim: 'an AUTH_USER RPC without a sub is signed (an anonymous token for a user RPC)',
    anchor: "    if (typeof sub !== 'string' || (sub === '' ? !isPublic : !SUB.test(sub))) {",
    replacement: '    if (false) {',
  },
  {
    id: 'S02',
    subject: 'signer',
    claim: 'a token request that does not state its auth is treated as AUTH_PUBLIC (fails open)',
    anchor: "    const isPublic = request.auth === 'public';",
    replacement: "    const isPublic = request.auth !== 'user';",
  },
  {
    id: 'S03',
    subject: 'signer',
    claim: 'a token lives an hour instead of at most 60 s',
    anchor: TTL,
    replacement: 'export const TOKEN_TTL_SECONDS = 3600;',
  },
  {
    id: 'S04',
    subject: 'signer',
    claim: 'a current.kid that does not match current.key is signed under anyway',
    anchor: '  if (kidFile !== kid) {',
    replacement: '  if (false) {',
  },
  {
    id: 'S05',
    subject: 'signer',
    claim: 'the key is read once and never again: a rotation needs a restart',
    anchor:
      '        if (loaded?.fingerprint !== fingerprint) loaded = load(keyDir, dir, fingerprint);',
    replacement: '        if (!loaded) loaded = load(keyDir, dir, fingerprint);',
  },
  {
    id: 'S06',
    subject: 'signer',
    claim: 'a key that is not Ed25519 (RSA) is accepted',
    anchor: "  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {",
    replacement: "  if (key.type !== 'private') {",
  },
  {
    id: 'S07',
    subject: 'signer',
    claim: 'an issuer that is not knext:zone:<namespace>/<zone> still gets a token',
    anchor:
      '    if (!zone) throw refuse(`${ZONE_ISSUER_ENV} is not knext:zone:<namespace>/<zone>`);',
    replacement: "    if (!zone) return 'unsigned.token.issuer';",
  },
  {
    id: 'S08',
    subject: 'signer',
    claim: 'a function in another namespace than the zone gets a token',
    anchor: '    if (fn[1] !== zone[1]) {',
    replacement: '    if (false) {',
  },
  {
    id: 'S09',
    subject: 'signer',
    claim:
      'an address that only STARTS like a function address (…svc.cluster.local.evil.example) is an audience',
    anchor:
      'const FUNCTION_HOST = new RegExp(`^(${LABEL})\\\\.(${LABEL})\\\\.svc\\\\.cluster\\\\.local$`);',
    replacement:
      'const FUNCTION_HOST = new RegExp(`^(${LABEL})\\\\.(${LABEL})\\\\.svc\\\\.cluster\\\\.local`);',
  },
  {
    id: 'S10',
    subject: 'signer',
    claim: 'a method claim that is not a fully qualified RPC path is signed',
    anchor: "    if (typeof method !== 'string' || !RPC_PATH.test(method)) {",
    replacement: '    if (false) {',
  },
  {
    id: 'S11',
    subject: 'signer',
    claim: 'the token sub is taken from a userId the caller passes, over the verified user',
    anchor: "    const sub = request.sub ?? '';",
    replacement: "    const sub = (request as { userId?: string }).userId ?? request.sub ?? '';",
  },
  {
    id: 'S12',
    subject: 'signer',
    claim: 'the kid is derived from 32 bytes of the digest instead of the first 16',
    anchor:
      "  return createHash('sha256').update(raw).digest().subarray(0, 16).toString('base64url');",
    replacement:
      "  return createHash('sha256').update(raw).digest().subarray(0, 32).toString('base64url');",
  },
  {
    id: 'S13',
    subject: 'signer',
    claim: 'every minted token is written to the log',
    anchor: MINT_RETURN,
    replacement: `    console.error(\`\${input}.\${signature}\`);\n${MINT_RETURN}`,
  },
];

// ── the generated glue, against a real verifier ──────────────────────────
const MINT_AUTH = '    `auth: ${JSON.stringify(p.auth)}, sub: ${sub}(${subject}) })`';
const GLUE = [
  {
    id: 'P01',
    subject: 'plugin',
    claim:
      "the token request no longer states the RPC's auth (a public read is refused, a user RPC unmarked)",
    anchor: MINT_AUTH,
    replacement: '    `sub: ${sub}(${subject}) })`',
  },
  {
    id: 'P02',
    subject: 'plugin',
    claim: 'every token request says AUTH_PUBLIC, so a user RPC may go without a user',
    anchor: MINT_AUTH,
    replacement: '    `auth: "public", sub: ${sub}(${subject}) })`',
  },
  {
    id: 'P03',
    subject: 'plugin',
    claim: 'the token sub is read from the request body before the verified user',
    anchor: MINT_AUTH,
    replacement:
      '    `auth: ${JSON.stringify(p.auth)}, sub: (request as { sub?: string }).sub ?? ${sub}(${subject}) })`',
  },
];

// ── generate refuses a zone without an authorize() export ─────────────────
const REFUSAL = [
  {
    id: 'R01',
    subject: 'generate',
    claim: 'an authorize module that does not export authorize by name is generated against',
    anchor: "    if (!exportsAuthorize(readFileSync(join(cwd, config.authorize), 'utf8'))) {",
    replacement: '    if (false) {',
  },
];

// ── the lexical export check ──────────────────────────────────────────────
const EXPORT = [
  {
    id: 'C01',
    subject: 'config',
    claim: 'a block comment holding an export counts as an export',
    anchor: "    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')",
    replacement: "    .replace(/$^/g, ' ')",
  },
  {
    id: 'C02',
    subject: 'config',
    claim: 'a commented-out export counts as an export',
    anchor: "    .replace(/(^|[^:'\"`\\\\])\\/\\/[^\\n]*/g, '$1');",
    replacement: "    .replace(/$^/g, '$1');",
  },
  {
    id: 'C03',
    subject: 'config',
    claim: '`export type { authorize }` counts as exporting the authorize() value',
    anchor: '    if (list[1]) continue; // `export type { ... }` exports no value',
    replacement: '    void list[1];',
  },
];

// ── Node and Bun gateways: a leaked token is seen ─────────────────────────
const GATEWAY = [
  {
    id: 'L01',
    subject: 'signer',
    claim: 'a gateway prints every token it mints (Node and Bun)',
    anchor: MINT_RETURN,
    replacement: `    console.error(\`\${input}.\${signature}\`);\n${MINT_RETURN}`,
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const signer = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/zone-signer.test.ts',
  subjects: { signer: 'packages/grpc/src/signer.ts' },
});
const glue = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/zone-signer-glue.test.ts',
  subjects: {
    plugin: 'packages/grpc/src/glue-plugin.ts',
    signer: 'packages/grpc/src/signer.ts',
  },
});
const refusal = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/glue-refusals.test.ts',
  subjects: { generate: 'packages/grpc/src/generate.ts' },
});
const exportCheck = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/authorize-export.test.ts',
  subjects: { config: 'packages/grpc/src/config.ts' },
});
const gateway = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/zone-signer-gateway.test.ts',
  subjects: { signer: 'packages/grpc/src/signer.ts' },
});

console.log('=== mutation proof: zone-side identity token (#2051) ===');
signer.preflight(SIGNER);
glue.preflight(GLUE);
refusal.preflight(REFUSAL);
exportCheck.preflight(EXPORT);
gateway.preflight(GATEWAY);
declareMutations(SIGNER.length + GLUE.length + REFUSAL.length + EXPORT.length + GATEWAY.length);

console.log('\n=== the signer ===');
signer.baseline();
signer.proveCanSeeRed({
  subject: 'signer',
  anchor: MINT_RETURN,
  replacement: "    return 'canary.not.signed';",
});
for (const m of SIGNER) {
  signer.run({ ...m, expect: 'red' });
  recordMutation();
}
signer.finish(SIGNER.length);

console.log('\n=== the generated glue, against a real verifier ===');
glue.baseline();
glue.proveCanSeeRed({
  subject: 'signer',
  anchor: TTL,
  replacement: 'export const TOKEN_TTL_SECONDS = -1;',
});
for (const m of GLUE) {
  glue.run({ ...m, expect: 'red' });
  recordMutation();
}
glue.finish(GLUE.length);

console.log('\n=== knext generate refuses a zone without an authorize() export ===');
refusal.baseline();
refusal.proveCanSeeRed({
  subject: 'generate',
  anchor: '    if (!existsSync(join(cwd, config.authorize))) {',
  replacement: '    if (false) {',
});
for (const m of REFUSAL) {
  refusal.run({ ...m, expect: 'red' });
  recordMutation();
}
refusal.finish(REFUSAL.length);

console.log('\n=== the lexical authorize() export check ===');
exportCheck.baseline();
exportCheck.proveCanSeeRed({
  subject: 'config',
  anchor: '  return false;\n}\n\n/** Names a function may not take',
  replacement: '  return true;\n}\n\n/** Names a function may not take',
});
for (const m of EXPORT) {
  exportCheck.run({ ...m, expect: 'red' });
  recordMutation();
}
exportCheck.finish(EXPORT.length);

console.log('\n=== Node and Bun gateways: no token in the output ===');
gateway.baseline();
gateway.proveCanSeeRed({
  subject: 'signer',
  anchor: TTL,
  replacement: 'export const TOKEN_TTL_SECONDS = -1;',
});
for (const m of GATEWAY) {
  gateway.run({ ...m, expect: 'red' });
  recordMutation();
}
gateway.finish(GATEWAY.length);
