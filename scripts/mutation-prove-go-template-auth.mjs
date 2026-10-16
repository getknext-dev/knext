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
 *   A*  the interceptor and the verifier's mount check
 *       (internal/auth/auth.go, internal/auth/jwks.go): widening the health
 *       exemption, dropping the missing-token refusal, ignoring a verifier
 *       error, reading a missing JWKS as an empty one, dropping the
 *       nil-verifier fallback, loosening the bearer parse — each must RED.
 *       (A6, "a mounted JWKS admits every token", is retired with the stub it
 *       mutated: token verification is proved row by row in
 *       mutation-prove-2051-go-verifier.mjs.)
 *   W*  the binary's wiring (internal/rpc/rpc.go): the interceptor left
 *       out of the chain must RED (the on-the-wire scan of every registered
 *       procedure catches it).
 *   L*  the request-read bounds (internal/rpc/rpc.go): the gzip decompressor
 *       no longer stopping at the limit, the bounded compressor not mounted,
 *       the raw-body cap dropped, the ReadTimeout dropped — each must RED.
 *   D*  the SIGTERM drain: closing connections instead of draining them, or
 *       a grace of zero, must RED (an in-flight call is held open across the
 *       shutdown).
 *   N*  negative control: New naming its default auth policy explicitly
 *       (nil, the compiled contract) changes nothing, so the suite must stay
 *       GREEN. (The old control, New wired with a nil verifier, now reds by
 *       design: New must serve a valid zone token, and a nil verifier serves
 *       none. TestNilVerifierFailsClosed holds the deny-all fallback.)
 *
 * A row counts only if the mutated tree COMPILES: before its test run, each
 * row must pass a build-only `go test -run ^$` (packages and their tests,
 * plus go test's vet subset). A row that does not compile is reported
 * NOT-COMPILED and fails the prover: a build failure kills nothing.
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
 * decoration, the negative control reddened, or a mutation did not
 * compile); 2 = the prover itself could
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
const JWKS = resolve(REPO_ROOT, 'templates/go/internal/auth/jwks.go');
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

// The same packages, compiled with their tests and run through go test's vet
// subset, running no test: `-run ^$` matches nothing.
const GO_BUILD = ['go', 'test', '-count=1', '-run', '^$', './internal/auth/', './internal/rpc/'];

// A row that deletes lines replaces them with '\n', never '': the harness
// appends its residue marker to a newline-free replacement as a trailing `//`
// comment, which swallows the line after the anchor. A7, W1 and L2 did that
// and did not compile (the build check refuses them); L4 compiled only because
// the line it swallowed was another field, so it mutated two things at once.
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
    anchor: '\t\t\tcaller, err := v.Verify(ctx, token, spec.Procedure)\n\t\t\tif err != nil {\n',
    replacement:
      '\t\t\tcaller, err := v.Verify(ctx, token, spec.Procedure)\n\t\t\tif err != nil && false {\n',
  },
  {
    id: 'A5',
    expect: 'red',
    claim: 'with no JWKS mounted, the verifier reads it as an empty one instead of refusing',
    subject: 'jwks',
    anchor: '\tif !jwksMounted(info, err) {\n\t\treturn nil, ErrNoJWKS\n\t}\n',
    replacement:
      '\tif !jwksMounted(info, err) {\n\t\treturn map[string]ed25519.PublicKey{}, nil\n\t}\n',
  },
  {
    id: 'A7',
    expect: 'red',
    claim: 'a nil verifier is no longer replaced by deny-all',
    subject: 'auth',
    anchor: '\tif v == nil {\n\t\tv = denyAll{err: errNoVerifier}\n\t}\n',
    replacement: '\n',
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
    subject: 'jwks',
    anchor: '\treturn err == nil && info.Mode().IsRegular() && info.Size() > 0\n',
    // Compiles (info stays used): a directory or an empty file now counts.
    replacement: '\treturn err == nil && info != nil\n',
  },
  // ── W: the binary's wiring ────────────────────────────────────────────────
  {
    id: 'W1',
    expect: 'red',
    claim: 'the token interceptor is left out of the server chain',
    subject: 'server',
    anchor: '\t\tauth.NewInterceptor(verifier),\n',
    replacement: '\n',
  },
  // ── L: the request-read bounds ────────────────────────────────────────────
  {
    id: 'L1',
    expect: 'red',
    claim: 'the gzip decompressor no longer stops one byte past the message limit',
    subject: 'server',
    anchor: '\treturn limitedReadCloser{Reader: io.LimitReader(r, c.limit+1), Closer: r}, nil\n',
    replacement: '\treturn r, nil\n',
  },
  {
    id: 'L2',
    expect: 'red',
    claim: "the bounded gzip is not mounted (connect-go's default gzip drains a bomb)",
    subject: 'server',
    anchor: '\t\tconnecthttp.WithCompressors(boundedGzip(MaxRequestBytes)),\n',
    replacement: '\n',
  },
  {
    id: 'L3',
    expect: 'red',
    claim: 'the raw request-body cap is dropped (an endless body is read forever)',
    subject: 'server',
    anchor: '\t\t\tHandler:           http.MaxBytesHandler(mux, MaxRequestBodyBytes),\n',
    replacement: '\t\t\tHandler:           mux,\n',
  },
  {
    id: 'L4',
    expect: 'red',
    claim: 'the server has no ReadTimeout (a stalled body is never cut off)',
    subject: 'server',
    anchor: '\t\t\tReadTimeout:       ReadTimeout,\n',
    replacement: '\n',
  },
  // ── D: the SIGTERM drain ──────────────────────────────────────────────────
  {
    id: 'D1',
    expect: 'red',
    claim: 'SIGTERM closes connections instead of draining in-flight calls',
    subject: 'server',
    anchor: '\tif err := f.HTTP.Shutdown(shutdownCtx); err != nil {\n',
    replacement: '\tif err := errors.Join(f.HTTP.Close(), shutdownCtx.Err()); err != nil {\n',
  },
  {
    id: 'D2',
    expect: 'red',
    claim: 'the drain grace is zero (Serve returns with a call still in flight)',
    subject: 'server',
    anchor: '\tshutdownCtx, cancel := context.WithTimeout(context.Background(), ShutdownGrace)\n',
    replacement: '\tshutdownCtx, cancel := context.WithTimeout(context.Background(), 0)\n',
  },
  // ── N: negative control ───────────────────────────────────────────────────
  {
    id: 'N1',
    expect: 'green',
    claim:
      'New naming its default auth policy explicitly (nil: the compiled contract) changes nothing',
    subject: 'server',
    anchor: '\t\tNow:      cfg.Now,\n\t}))\n',
    replacement: '\t\tNow:      cfg.Now,\n\t\tMethodAuth: nil,\n\t}))\n',
  },
];

const PROVER = { subjects: { auth: AUTH, jwks: JWKS, server: SERVER } };

// Returns the command's exit code, or null if go could not be run. Never exits
// here: a caller holding a mutation must restore it first.
function goExit(command) {
  const [bin, ...args] = command;
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

// Green baseline on a clean tree, else every verdict below is noise. The
// build-only check must pass too, or no row's build check could mean anything.
assertTreeClean(REPO_ROOT, 'baseline');
const baseBuild = goExit(GO_BUILD);
if (baseBuild === null) process.exit(2);
if (baseBuild !== 0) {
  console.error(
    `mutation-prove-go-template-auth: baseline does not compile (exit ${baseBuild}); fix the tree first`,
  );
  process.exit(2);
}
const base = goExit(GO_TEST);
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
  let build;
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    // A mutation that does not compile is red for the wrong reason: the test
    // run would fail at the build, proving nothing about any guard.
    build = goExit(GO_BUILD);
    if (build === 0) code = goExit(GO_TEST);
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  if (build === null || code === null) process.exit(2);
  recordMutation();
  if (build !== 0) {
    failed++;
    console.error(
      `*** NOT-COMPILED *** ${m.id} build exit=${build}: the mutated tree does not compile, so this row proves nothing; make it a compiling mutation — ${m.claim}`,
    );
    continue;
  }
  const ok = m.expect === 'red' ? code !== 0 : code === 0;
  if (!ok) failed++;
  const verdict = ok ? (m.expect === 'red' ? 'KILLED   ' : 'TOLERATED') : '*** SURVIVED ***';
  console.log(`${verdict} ${m.id} expect=${m.expect} exit=${code} — ${m.claim}`);
}

console.log(
  `mutation-prove-go-template-auth: ${MUTATIONS.length - failed}/${MUTATIONS.length} behaved as required`,
);
process.exit(failed === 0 ? 0 : 1);
