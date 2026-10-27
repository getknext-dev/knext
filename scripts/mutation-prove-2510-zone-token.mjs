#!/usr/bin/env node
/**
 * Mutation proof for the zone side of token replay protection (#2510): the
 * signer that gives every token a jti, the client runtime and generated glue
 * that ask for a NEW token on every attempt of a retried read, the kind lane's
 * probe, and the lane's "same token sent twice" row.
 *
 * Four guards, four specs, one table each:
 *
 *   - `zone-signer.test.ts` — the signer: a jti on every token, at least 128
 *     bits, from the CSPRNG (never repeated, even on one clock reading), and
 *     signed.
 *   - `runtime.test.ts` — the client runtime: a read retried after the
 *     function accepted its token asks the token source again (a token is
 *     single-use), a mint failure before the first attempt is "not sent", an
 *     unusable token is refused, and a stream takes a string.
 *   - `zone-signer-glue.test.ts` — the generated glue against a real Connect
 *     verifier that refuses a jti it has seen: a retried generated query sends
 *     a different token on each attempt.
 *   - `z7-e2e-probe.test.ts` — the kind lane's probe: hand-built tokens carry
 *     their own jti, and `--twice` sends the SAME token twice.
 *   - `z7-identity-kind-e2e-lane.test.ts` — the lane's refusal matrix: the
 *     "same token sent twice" row is there, sends once-then-again, and expects
 *     200 then 401.
 *
 * The shared vectors and the Go and Rust verifiers are proved by
 * `mutation-prove-2510-go-verifier.mjs` and `-rust-verifier.mjs`: a mutation
 * of the generator would be killed by its freshness test whatever it meant, so
 * it proves nothing here.
 *
 * Each mutation removes ONE behaviour and requires its spec to go red. Verdicts
 * are by EXIT CODE only (the shared driver, `scripts/lib/guard-prover.mjs`),
 * every anchor must occur exactly once (preflight first), each baseline must be
 * green, a canary must go red before any green is trusted, and every restore is
 * content-verified. The specs run with a PRIVATE TMPDIR (removed on exit).
 *
 * Usage:  node scripts/mutation-prove-2510-zone-token.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A private scratch directory: the specs' temp files go here, not into a shared
// temp directory, and it is removed when the prover exits, however it exits.
const SCRATCH = mkdtempSync(join(tmpdir(), 'knext-prove-2510-ts-'));
process.env.TMPDIR = SCRATCH;
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }));

const MINT_RETURN = '    return `${input}.${signature}`;';
const JTI = "    const jti = randomBytes(JTI_BYTES).toString('base64url');";
const CLAIMS =
  '      JSON.stringify({ iss, aud, method, sub, jti, iat, exp: iat + TOKEN_TTL_SECONDS }),';
const RAW_JTI =
  '          jti: newJti(),\n          iat,\n          exp: iat + (a.lifetimeSeconds ?? TOKEN_TTL_SECONDS),';

// ── the signer ────────────────────────────────────────────────────────────
const SIGNER = [
  {
    id: 'T01',
    subject: 'signer',
    claim: 'a token carries no jti (nothing to remember, so nothing to refuse a replay by)',
    anchor: CLAIMS,
    replacement:
      '      JSON.stringify({ iss, aud, method, sub, iat, exp: iat + TOKEN_TTL_SECONDS }),',
  },
  {
    id: 'T02',
    subject: 'signer',
    claim: 'every token carries the same jti (the second call of a zone is a "replay")',
    anchor: JTI,
    replacement: "    const jti = 'AAAAAAAAAAAAAAAAAAAAAA';",
  },
  {
    id: 'T03',
    subject: 'signer',
    claim: 'the jti is 64 bits, not 128',
    anchor: 'const JTI_BYTES = 16;',
    replacement: 'const JTI_BYTES = 8;',
  },
  {
    id: 'T04',
    subject: 'signer',
    claim: 'the jti is derived from the clock, not random: two mints in one second share it',
    anchor: JTI,
    replacement:
      "    const jti = Buffer.from(String(iat).padStart(JTI_BYTES, '0')).toString('base64url');",
  },
  {
    id: 'T05',
    subject: 'signer',
    claim: 'the jti is added outside the signed bytes (swapping it does not break the signature)',
    anchor: CLAIMS,
    replacement:
      '      JSON.stringify({ iss, aud, method, sub, iat, exp: iat + TOKEN_TTL_SECONDS }).replace(/}$/, `,"jti":"${jti}"}`),',
  },
];

// ── the client runtime ─────────────────────────────────────────────────────
const RUNTIME = [
  {
    id: 'R01',
    subject: 'runtime',
    claim:
      'a retried read re-sends the first attempt’s token (the function refuses it as a replay)',
    anchor: 'const token = attempt === 1 ? firstToken : await tokenFor(options?.token);',
    replacement: 'const token = firstToken;',
  },
  {
    id: 'R02',
    subject: 'runtime',
    claim:
      'a mint failure before the first attempt is not marked "not sent" (a write is refreshed)',
    anchor: '        throw markNotSent(err);\n      }\n      const deadlineAt',
    replacement: '        throw ConnectError.from(err);\n      }\n      const deadlineAt',
  },
  {
    id: 'R03',
    subject: 'runtime',
    claim: 'a token that is not a bearer token (a space, 8 KiB+) is sent anyway',
    anchor:
      "    if (typeof value !== 'string' || !/^[\\x21-\\x7e]{1,8192}$/.test(value)) {\n      throw new ConnectError('the call token is not a usable bearer token', Code.Unauthenticated);",
    replacement:
      "    if (false) {\n      throw new ConnectError('the call token is not a usable bearer token', Code.Unauthenticated);",
  },
  {
    id: 'R04',
    subject: 'runtime',
    claim: 'a stream accepts a token source (it would be called once, silently)',
    anchor: "        if (typeof token === 'function') {\n          throw new ConnectError(",
    replacement: '        if (false) {\n          throw new ConnectError(',
  },
  {
    id: 'R05',
    subject: 'runtime',
    claim: 'the token never reaches the Authorization header',
    anchor: '    headers.set(AUTHORIZATION_HEADER, `Bearer ${token}`);\n    return headers;',
    replacement: '    return headers;',
  },
];

// ── the generated glue ─────────────────────────────────────────────────────
const GLUE = [
  {
    id: 'G01',
    subject: 'plugin',
    claim: 'a generated query mints its token once, so a retried read re-sends it',
    anchor: "    `  const token = async () => ${mintExpr(ctx, p, 'subject')};`,",
    replacement: "    `  const token = ${mintExpr(ctx, p, 'subject')};`,",
  },
];

// ── the kind lane's probe ──────────────────────────────────────────────────
const PROBE = [
  {
    id: 'P01',
    subject: 'probeLib',
    claim: 'a hand-built token carries no jti (the function would refuse it as missing-jti)',
    anchor: RAW_JTI,
    replacement: '          iat,\n          exp: iat + (a.lifetimeSeconds ?? TOKEN_TTL_SECONDS),',
  },
  {
    id: 'P02',
    subject: 'probeLib',
    claim: 'every hand-built token shares one jti',
    anchor: "const newJti = (): string => randomBytes(16).toString('base64url');",
    replacement: "const newJti = (): string => 'AAAAAAAAAAAAAAAAAAAAAA';",
  },
  {
    id: 'P03',
    subject: 'probe',
    claim: '--twice sends the token once',
    anchor: 'for (let call = 0; call < (values.twice ? 2 : 1); call++) {',
    replacement: 'for (let call = 0; call < 1; call++) {',
  },
];

// ── the kind lane's refusal matrix ─────────────────────────────────────────
const REPLAY_ROW =
  '  expect_replay "${label}: the same token sent twice, the second use is refused" \\\n' +
  '    "${common[@]}" --rpc put --id "replay-${label}" --value "r-${label}" --auth signer --key-dir "${keydir}"\n';
const LANE = [
  {
    id: 'K01',
    subject: 'runSh',
    claim: 'the refusal matrix has no "same token sent twice" row',
    anchor: REPLAY_ROW,
    replacement: '',
  },
  {
    id: 'K02',
    subject: 'runSh',
    claim: 'the replay helper sends the token once (the second use is never tried)',
    anchor: '  out="$(probe "$@" --twice)" || fail "${desc}: the function did not answer"\n',
    replacement: '  out="$(probe "$@")" || fail "${desc}: the function did not answer"\n',
  },
  {
    id: 'K03',
    subject: 'runSh',
    claim: 'the replay helper accepts any second status (a served replay would pass)',
    anchor: '  [ "$(jq -r .status <<<"${second}")" = 401 ] && ',
    replacement: '  [ "$(jq -r .status <<<"${second}")" != 0 ] && ',
  },
  {
    id: 'K04',
    subject: 'runSh',
    claim: 'the replay helper does not require the first use to be accepted',
    anchor: '  [ "$(jq -r .status <<<"${first}")" = 200 ] \\\n',
    replacement: '  [ "$(jq -r .status <<<"${first}")" != 0 ] \\\n',
  },
];

const signer = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/zone-signer.test.ts',
  subjects: { signer: 'packages/grpc/src/signer.ts' },
});
const runtime = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/runtime.test.ts',
  subjects: { runtime: 'packages/grpc/src/runtime.ts' },
});
const glue = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/zone-signer-glue.test.ts',
  subjects: { plugin: 'packages/grpc/src/glue-plugin.ts', signer: 'packages/grpc/src/signer.ts' },
});
const probe = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/z7-e2e-probe.test.ts',
  subjects: {
    probeLib: 'packages/grpc/e2e/z7-identity-kind/probe-lib.ts',
    probe: 'packages/grpc/e2e/z7-identity-kind/probe.ts',
  },
});
const lane = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/z7-identity-kind-e2e-lane.test.ts',
  subjects: { runSh: 'packages/grpc/e2e/z7-identity-kind/run.sh' },
});

console.log('=== mutation proof: zone-side token replay protection (#2510) ===');
signer.preflight(SIGNER);
runtime.preflight(RUNTIME);
glue.preflight(GLUE);
probe.preflight(PROBE);
lane.preflight(LANE);
declareMutations(SIGNER.length + RUNTIME.length + GLUE.length + PROBE.length + LANE.length);

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

console.log('\n=== the client runtime: a new token on every attempt ===');
runtime.baseline();
runtime.proveCanSeeRed({
  subject: 'runtime',
  anchor: 'const token = attempt === 1 ? firstToken : await tokenFor(options?.token);',
  replacement: 'const token = "canary token";',
});
for (const m of RUNTIME) {
  runtime.run({ ...m, expect: 'red' });
  recordMutation();
}
runtime.finish(RUNTIME.length);

console.log('\n=== the generated glue, against a verifier that refuses a seen jti ===');
glue.baseline();
glue.proveCanSeeRed({
  subject: 'signer',
  anchor: MINT_RETURN,
  replacement: "    return 'canary.not.signed';",
});
for (const m of GLUE) {
  glue.run({ ...m, expect: 'red' });
  recordMutation();
}
glue.finish(GLUE.length);

console.log("\n=== the kind lane's probe ===");
probe.baseline();
probe.proveCanSeeRed({
  subject: 'probeLib',
  anchor: "const newJti = (): string => randomBytes(16).toString('base64url');",
  replacement: "const newJti = (): string => 'x';",
});
for (const m of PROBE) {
  probe.run({ ...m, expect: 'red' });
  recordMutation();
}
probe.finish(PROBE.length);

console.log("\n=== the kind lane's refusal matrix ===");
lane.baseline();
lane.proveCanSeeRed({
  subject: 'runSh',
  anchor: REPLAY_ROW,
  replacement: '',
});
for (const m of LANE) {
  lane.run({ ...m, expect: 'red' });
  recordMutation();
}
lane.finish(LANE.length);
