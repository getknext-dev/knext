#!/usr/bin/env node
/**
 * Mutation prover for the Go zone-function template's token check
 * (templates/go): the interceptor FAILS CLOSED, and every way of opening it
 * is caught by a Go test.
 *
 * Each row plants one textual mutation (anchor EXACTLY ONCE in its subject,
 * via `lib/mutation-harness.mjs`, which marks residue and restores
 * byte-identically) and runs `go test` over the auth and server packages in
 * the template module, graded by EXIT CODE only:
 *
 *   A*  the interceptor and the verifier (internal/auth/auth.go): widening
 *       the health exemption, dropping the missing-token refusal, ignoring a
 *       verifier error, admitting with no JWKS or with a JWKS but no
 *       verifier, dropping the nil-verifier fallback, loosening the bearer
 *       parse — each must RED.
 *   W*  the binary's wiring (internal/rpc/rpc.go): the interceptor left
 *       out of the chain must RED (the on-the-wire scan of every registered
 *       procedure catches it).
 *   N*  negative control: New wired with a nil verifier is still closed, so
 *       the suite must stay GREEN (fail-closed by construction, not by the
 *       one verifier the binary happens to pass).
 *
 * NOT A JS TEST SUITE: the guards are Go tests, so there is no vitest runner
 * to resolve. Path-listed in `NON_JS_TEST_SUITE_PROVERS`
 * (`lib/prover-lane.mjs`); spawns only `go`, run in `templates/go`. The
 * template's go.mod names a newer Go than the operator's, so `go` runs with
 * GOTOOLCHAIN=auto and fetches the toolchain go.mod names if the one on PATH
 * is older.
 *
 *   node scripts/mutation-prove-go-template-auth.mjs
 *
 * Exit 0 = every row behaved as required; 1 = a row did not (a guard is
 * decoration, or the negative control reddened); 2 = the prover itself could
 * not run (anchor drift, red baseline, missing tool). Never parses output.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the command's cwd), not a mutation subject: kept out of the
// `resolve(REPO_ROOT, …)` subject shape the anchor scanners read.
const TEMPLATE_MODULE = `${REPO_ROOT}/templates/go`;
const AUTH = resolve(REPO_ROOT, 'templates/go/internal/auth/auth.go');
const SERVER = resolve(REPO_ROOT, 'templates/go/internal/rpc/rpc.go');

// -count=1: never trust a cached pass for a mutated tree. -timeout: a
// mutation that HANGS a test (a wrongly served stream) is a red exit from
// go test itself, well inside the spawn timeout below.
const GO_TEST = [
  'go',
  'test',
  '-count=1',
  '-timeout',
  '180s',
  './internal/auth/',
  './internal/rpc/',
];

const MUTATIONS = [
  // ── A: the interceptor and the verifier ───────────────────────────────────
  {
    id: 'A1',
    expect: 'red',
    claim: 'the health exemption widens to every read (NO_SIDE_EFFECTS) RPC',
    subject: 'auth',
    anchor: '\t\t\tif spec.Procedure == HealthCheckProcedure {\n',
    replacement:
      '\t\t\tif spec.Procedure == HealthCheckProcedure || spec.IdempotencyLevel == connect.IdempotencyNoSideEffects {\n',
  },
  {
    id: 'A2',
    expect: 'red',
    claim: 'the health exemption widens to the whole health service (Watch included)',
    subject: 'auth',
    anchor: '\t\t\tif spec.Procedure == HealthCheckProcedure {\n',
    replacement: '\t\t\tif strings.HasPrefix(spec.Procedure, "/grpc.health.v1.Health/") {\n',
  },
  {
    id: 'A3',
    expect: 'red',
    claim: 'a call with no bearer token is passed to the verifier instead of refused',
    subject: 'auth',
    anchor:
      '\t\t\tif !ok {\n\t\t\t\treturn connect.NewError(connect.CodeUnauthenticated, "missing bearer token")\n\t\t\t}\n',
    replacement: '\t\t\t_ = ok\n',
  },
  {
    id: 'A4',
    expect: 'red',
    claim: 'a verifier error is ignored',
    subject: 'auth',
    anchor: 'if err := v.Verify(ctx, token, spec.Procedure); err != nil {',
    replacement: 'if err := v.Verify(ctx, token, spec.Procedure); err != nil && false {',
  },
  {
    id: 'A5',
    expect: 'red',
    claim: 'with no JWKS mounted, every token is admitted',
    subject: 'auth',
    anchor: '\t\treturn ErrNoJWKS\n',
    replacement: '\t\treturn nil\n',
  },
  {
    id: 'A6',
    expect: 'red',
    claim: 'a mounted JWKS admits every token though nothing verifies it',
    subject: 'auth',
    anchor: '\treturn ErrVerificationUnavailable\n',
    replacement: '\treturn nil\n',
  },
  {
    id: 'A7',
    expect: 'red',
    claim: 'a nil verifier is no longer replaced by deny-all',
    subject: 'auth',
    anchor: '\tif v == nil {\n\t\tv = denyAll{err: errNoVerifier}\n\t}\n',
    replacement: '',
  },
  {
    id: 'A8',
    expect: 'red',
    claim: 'the bearer parse accepts any scheme',
    subject: 'auth',
    anchor: '\tif !strings.HasPrefix(header, prefix) {\n\t\treturn "", false\n\t}\n',
    replacement: '\tif len(header) < len(prefix) {\n\t\treturn "", false\n\t}\n',
  },
  {
    id: 'A9',
    expect: 'red',
    claim: 'an empty bearer token counts as present',
    subject: 'auth',
    anchor: '\treturn token, token != ""\n',
    replacement: '\treturn token, true\n',
  },
  {
    id: 'A10',
    expect: 'red',
    claim: 'an empty or directory JWKS path counts as mounted',
    subject: 'auth',
    anchor: '\treturn err == nil && info.Mode().IsRegular() && info.Size() > 0\n',
    replacement: '\treturn err == nil\n',
  },
  // ── W: the binary's wiring ────────────────────────────────────────────────
  {
    id: 'W1',
    expect: 'red',
    claim: 'the token interceptor is left out of the server chain',
    subject: 'server',
    anchor: '\t\tauth.NewInterceptor(verifier),\n',
    replacement: '',
  },
  // ── N: negative control ───────────────────────────────────────────────────
  {
    id: 'N1',
    expect: 'green',
    claim: 'New wired with a nil verifier is still closed (deny-all fallback)',
    subject: 'server',
    anchor: '\treturn newFunction(cfg, auth.MountedJWKS(cfg.JWKSPath))\n',
    replacement: '\treturn newFunction(cfg, nil)\n',
  },
];

const PROVER = { subjects: { auth: AUTH, server: SERVER } };

// Returns go test's exit code, or null if go could not be run. Never exits
// here: a caller holding a mutation must restore it first.
function goTestExit() {
  const [bin, ...args] = GO_TEST;
  const r = spawnSync(bin, args, {
    cwd: TEMPLATE_MODULE,
    env: { ...process.env, GOTOOLCHAIN: 'auto' },
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 600_000,
  });
  if (r.error || r.status === null) {
    console.error(
      `mutation-prove-go-template-auth: cannot run ${bin}: ${r.error?.message ?? r.signal}`,
    );
    return null;
  }
  return r.status;
}

declareMutations(MUTATIONS.length);
console.log(`mutation-prove-go-template-auth: ${MUTATIONS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of MUTATIONS) {
  const path = PROVER.subjects[m.subject];
  if (path === undefined) {
    console.error(`mutation-prove-go-template-auth: ${m.id} names no subject ${m.subject}`);
    process.exit(2);
  }
  const count = snapshot(path).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `mutation-prove-go-template-auth: ${m.id}'s anchor occurs ${count} times in ${path}; aborting`,
    );
    process.exit(2);
  }
}

// Green baseline on a clean tree, else every verdict below is noise.
assertTreeClean(REPO_ROOT, 'baseline');
const base = goTestExit();
if (base === null) process.exit(2);
if (base !== 0) {
  console.error(`mutation-prove-go-template-auth: baseline RED (exit ${base}); fix the tree first`);
  process.exit(2);
}
console.log('mutation-prove-go-template-auth: baseline green');

let failed = 0;
for (const m of MUTATIONS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(PROVER.subjects[m.subject]);
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    code = goTestExit();
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  if (code === null) process.exit(2);
  recordMutation();
  const ok = m.expect === 'red' ? code !== 0 : code === 0;
  if (!ok) failed++;
  const verdict = ok ? (m.expect === 'red' ? 'KILLED   ' : 'TOLERATED') : '*** SURVIVED ***';
  console.log(`${verdict} ${m.id} expect=${m.expect} exit=${code} — ${m.claim}`);
}

console.log(
  `mutation-prove-go-template-auth: ${MUTATIONS.length - failed}/${MUTATIONS.length} behaved as required`,
);
process.exit(failed === 0 ? 0 : 1);
