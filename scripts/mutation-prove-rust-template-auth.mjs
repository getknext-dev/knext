#!/usr/bin/env node
/**
 * Mutation prover for the Rust zone-function template's token check
 * (templates/rust): the check FAILS CLOSED, the request reads are bounded,
 * and every way of opening either is caught by a Rust test.
 *
 * Each row plants one textual mutation (anchor EXACTLY ONCE in its subject,
 * via `lib/mutation-harness.mjs`, which marks residue and restores
 * byte-identically) and runs `cargo test` over the template crate's unit
 * tests, graded by EXIT CODE only:
 *
 *   A*  the token check and the verifier (src/auth.rs): widening the health
 *       exemption (to Connect GET reads, to the whole health service),
 *       passing a missing token to the verifier, ignoring a verifier error,
 *       admitting with no JWKS or with a JWKS but no verification, dropping
 *       the deny-all fallback for a missing verifier, loosening the bearer
 *       parse, counting an empty or directory JWKS as mounted — each must RED.
 *   W*  the server's wiring (src/rpc/mod.rs): the token layer left out of the
 *       stack must RED (the on-the-wire scan of every registered procedure
 *       catches it).
 *   L*  the request-read bounds (src/rpc/mod.rs, src/rpc/body.rs): the
 *       message limit lifted, the body cap lifted at the wiring or in the
 *       body, the read timeout lifted at the wiring or in the body, zstd
 *       accepted beside gzip — each must RED.
 *   C*  the connection bounds (src/rpc/mod.rs): a silent connection never
 *       closed, an idle connection never reaped — each must RED.
 *   D*  the SIGTERM drain: closing connections instead of draining them, a
 *       grace of zero, or not waiting at all must RED.
 *   R*  panic recovery and tracing (src/rpc/layers.rs): a panic no longer
 *       caught, a span that ignores the caller's trace — each must RED.
 *   N*  negative control: the production constructor wired with no verifier
 *       is still closed, so the suite must stay GREEN (fail-closed by
 *       construction, not by the one verifier the binary happens to pass).
 *
 * A row counts only if the mutated tree COMPILES: before its test run, each
 * row must pass a build-only `cargo test --no-run` (the crate and its tests).
 * A row that does not compile is reported NOT-COMPILED and fails the prover:
 * a build failure kills nothing.
 *
 * NOT A JS TEST SUITE: the guards are Rust tests, so there is no vitest
 * runner to resolve. Path-listed in `NON_JS_TEST_SUITE_PROVERS`
 * (`lib/prover-lane.mjs`); spawns only `cargo`, run in `templates/rust`
 * (whose rust-toolchain.toml picks the toolchain).
 *
 *   node scripts/mutation-prove-rust-template-auth.mjs
 *
 * Exit 0 = every row behaved as required; 1 = a row did not (a guard is
 * decoration, the negative control reddened, or a mutation did not compile);
 * 2 = the prover itself could not run (anchor drift, red baseline, missing
 * tool). Never parses output.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The crate (the command's cwd), not a mutation subject: kept out of the
// `resolve(REPO_ROOT, …)` subject shape the anchor scanners read.
const TEMPLATE_CRATE = `${REPO_ROOT}/templates/rust`;
const AUTH = resolve(REPO_ROOT, 'templates/rust/src/auth.rs');
const SERVER = resolve(REPO_ROOT, 'templates/rust/src/rpc/mod.rs');
const BODY = resolve(REPO_ROOT, 'templates/rust/src/rpc/body.rs');
const LAYERS = resolve(REPO_ROOT, 'templates/rust/src/rpc/layers.rs');

// --lib: the unit tests, where every guard lives. A test that HANGS under a
// mutation is bounded by the tests' own timeouts, well inside the spawn
// timeout below.
const CARGO_TEST = ['cargo', 'test', '--locked', '--lib'];

// The same crate and its tests, compiled, running nothing.
const CARGO_BUILD = ['cargo', 'test', '--locked', '--lib', '--no-run'];

// A row that deletes lines replaces them with '\n', never '': the harness
// appends its residue marker to a newline-free replacement as a trailing `//`
// comment, which would swallow the line after the anchor.
const MUTATIONS = [
  // ── A: the token check and the verifier ───────────────────────────────────
  {
    id: 'A1',
    expect: 'red',
    claim: 'the health exemption widens to every Connect GET (the read form)',
    subject: 'auth',
    anchor: '        if procedure == HEALTH_CHECK_PROCEDURE {\n',
    replacement:
      '        if procedure == HEALTH_CHECK_PROCEDURE || req.method() == http::Method::GET {\n',
  },
  {
    id: 'A2',
    expect: 'red',
    claim: 'the health exemption widens to the whole health service (Watch included)',
    subject: 'auth',
    anchor: '        if procedure == HEALTH_CHECK_PROCEDURE {\n',
    replacement: '        if procedure.starts_with("/grpc.health.v1.Health/") {\n',
  },
  {
    id: 'A3',
    expect: 'red',
    claim: 'a call with no bearer token is passed to the verifier instead of refused',
    subject: 'auth',
    anchor:
      '        let Some(token) = token else {\n            return Either::Right(ready(Ok(refusal(req.headers(), "missing bearer token"))));\n        };\n',
    replacement: '        let token = token.unwrap_or_default();\n',
  },
  {
    id: 'A4',
    expect: 'red',
    claim: 'a verifier error is ignored',
    subject: 'auth',
    anchor: '        if let Err(err) = self.verifier.verify(token, procedure) {\n',
    replacement:
      '        if let Err(err) = self.verifier.verify(token, procedure).or(Ok::<(), AuthError>(())) {\n',
  },
  {
    id: 'A5',
    expect: 'red',
    claim: 'with no JWKS mounted, every token is admitted',
    subject: 'auth',
    anchor: '            return Err(AuthError::NoJwks);\n',
    replacement: '            return Ok(());\n',
  },
  {
    id: 'A6',
    expect: 'red',
    claim: 'a mounted JWKS admits every token though nothing verifies it',
    subject: 'auth',
    anchor: '        Err(AuthError::VerificationUnavailable)\n',
    replacement: '        Ok(())\n',
  },
  {
    id: 'A7',
    expect: 'red',
    claim: 'a missing verifier is no longer replaced by deny-all',
    subject: 'auth',
    anchor: '            None => Arc::new(DenyAll(AuthError::NoVerifier)),\n',
    replacement:
      '            None => {\n                struct Open;\n                impl Verifier for Open {\n                    fn verify(&self, _: &str, _: &str) -> Result<(), AuthError> {\n                        Ok(())\n                    }\n                }\n                Arc::new(Open)\n            }\n',
  },
  {
    id: 'A8',
    expect: 'red',
    claim: 'the bearer parse accepts any scheme',
    subject: 'auth',
    anchor: '    let token = header.strip_prefix("Bearer ")?.trim();\n',
    replacement: "    let token = header.split_once(' ').map_or(header, |(_, t)| t).trim();\n",
  },
  {
    id: 'A9',
    expect: 'red',
    claim: 'an empty bearer token counts as present',
    subject: 'auth',
    anchor: '    (!token.is_empty()).then_some(token)\n',
    replacement: '    Some(token)\n',
  },
  {
    id: 'A10',
    expect: 'red',
    claim: 'an empty file or a directory at the JWKS path counts as mounted',
    subject: 'auth',
    anchor: '    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)\n',
    replacement: '    std::fs::metadata(path).is_ok()\n',
  },
  // ── W: the server's wiring ────────────────────────────────────────────────
  {
    id: 'W1',
    expect: 'red',
    claim: 'the token layer is left out of the server stack',
    subject: 'server',
    anchor: '        .layer(AuthLayer::new(verifier))\n',
    replacement: '        .layer(tower::layer::util::Identity::new())\n',
  },
  // ── L: the request-read bounds ────────────────────────────────────────────
  {
    id: 'L1',
    expect: 'red',
    claim: 'the message limit is lifted (a small gzip body inflates without bound)',
    subject: 'server',
    anchor: '                .with_max_message_size(MAX_REQUEST_BYTES)\n',
    replacement: '                .with_max_message_size(usize::MAX)\n',
  },
  {
    id: 'L2',
    expect: 'red',
    claim: 'the body cap is lifted at the wiring (an endless client stream is read forever)',
    subject: 'server',
    anchor: '            MAX_REQUEST_BODY_BYTES,\n            cfg.timeouts.read,\n',
    replacement: '            usize::MAX,\n            cfg.timeouts.read,\n',
  },
  {
    id: 'L3',
    expect: 'red',
    claim: 'the read timeout is lifted at the wiring (a stalled body is never cut off)',
    subject: 'server',
    anchor: '            MAX_REQUEST_BODY_BYTES,\n            cfg.timeouts.read,\n',
    replacement: '            MAX_REQUEST_BODY_BYTES,\n            Duration::from_secs(86_400),\n',
  },
  {
    id: 'L4',
    expect: 'red',
    claim: 'the bounded body no longer stops at its byte cap',
    subject: 'body',
    anchor: '                    if *this.read > *this.limit {\n',
    replacement: '                    if *this.read > *this.limit && *this.limit == 0 {\n',
  },
  {
    id: 'L5',
    expect: 'red',
    claim: 'the bounded body no longer checks its deadline',
    subject: 'body',
    anchor: '        if this.deadline.poll(cx).is_ready() {\n',
    replacement: '        if *this.limit == 0 && this.deadline.poll(cx).is_ready() {\n',
  },
  {
    id: 'L6',
    expect: 'red',
    claim: 'zstd is accepted beside gzip (the template accepts gzip only)',
    subject: 'server',
    anchor:
      '        .with_compression(CompressionRegistry::new().register(GzipProvider::new()));\n',
    replacement:
      '        .with_compression(\n            CompressionRegistry::new()\n                .register(GzipProvider::new())\n                .register(connectrpc::ZstdProvider::new()),\n        );\n',
  },
  // ── C: the connection bounds ──────────────────────────────────────────────
  {
    id: 'C1',
    expect: 'red',
    claim: 'a connection that never starts a request is not closed',
    subject: 'server',
    anchor: '                if (never_started && accepted.elapsed() >= timeouts.header_read)\n',
    replacement: '                if (never_started && accepted.elapsed() >= Duration::MAX)\n',
  },
  {
    id: 'C2',
    expect: 'red',
    claim: 'an idle connection is never reaped',
    subject: 'server',
    anchor: '                    || activity.idle_for(timeouts.idle, accepted)\n',
    replacement: '                    || activity.idle_for(Duration::MAX, accepted)\n',
  },
  // ── D: the SIGTERM drain ──────────────────────────────────────────────────
  {
    id: 'D1',
    expect: 'red',
    claim: 'SIGTERM closes connections instead of draining in-flight calls',
    subject: 'server',
    anchor:
      '                if changed.is_err() || *stop.borrow() {\n                    conn.as_mut().graceful_shutdown();\n',
    replacement:
      '                if changed.is_err() || *stop.borrow() {\n                    return;\n',
  },
  {
    id: 'D2',
    expect: 'red',
    claim: 'the drain grace is zero (serve fails with a call still in flight)',
    subject: 'server',
    anchor:
      '        match tokio::time::timeout(self.timeouts.shutdown_grace, live_rx.recv()).await {\n',
    replacement: '        match tokio::time::timeout(Duration::ZERO, live_rx.recv()).await {\n',
  },
  {
    id: 'D3',
    expect: 'red',
    claim: 'serve returns without waiting for in-flight calls',
    subject: 'server',
    anchor: '        drop(live_tx);\n',
    replacement:
      '        drop(live_tx);\n        if self.timeouts.shutdown_grace > Duration::ZERO {\n            return Ok(());\n        }\n',
  },
  // ── R: panic recovery and tracing ─────────────────────────────────────────
  {
    id: 'R1',
    expect: 'red',
    claim: 'a panicking handler is no longer caught (the connection dies with it)',
    subject: 'layers',
    anchor: '                Ok(call) => AssertUnwindSafe(call).catch_unwind().await,\n',
    replacement: '                Ok(call) => Ok(call.await),\n',
  },
  {
    id: 'R2',
    expect: 'red',
    claim: "the call's span ignores the caller's trace context",
    subject: 'layers',
    anchor: '            .start_with_context(self.layer.tracer.as_ref(), &parent);\n',
    replacement:
      '            .start_with_context(self.layer.tracer.as_ref(), &opentelemetry::Context::new());\n',
  },
  // ── N: negative control ───────────────────────────────────────────────────
  {
    id: 'N1',
    expect: 'green',
    claim: 'the production constructor wired with no verifier is still closed (deny-all fallback)',
    subject: 'server',
    anchor: '    build(example_router(), Some(verifier), cfg)\n',
    replacement: '    let _ = &verifier;\n    build(example_router(), None, cfg)\n',
  },
];

const PROVER = { subjects: { auth: AUTH, server: SERVER, body: BODY, layers: LAYERS } };

// Returns the command's exit code, or null if cargo could not be run. Never
// exits here: a caller holding a mutation must restore it first.
function cargoExit(command) {
  const [bin, ...args] = command;
  const r = spawnSync(bin, args, {
    cwd: TEMPLATE_CRATE,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 900_000,
  });
  if (r.error || r.status === null) {
    console.error(
      `mutation-prove-rust-template-auth: cannot run ${bin}: ${r.error?.message ?? r.signal}`,
    );
    return null;
  }
  return r.status;
}

declareMutations(MUTATIONS.length);
console.log(`mutation-prove-rust-template-auth: ${MUTATIONS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of MUTATIONS) {
  const path = PROVER.subjects[m.subject];
  if (path === undefined) {
    console.error(`mutation-prove-rust-template-auth: ${m.id} names no subject ${m.subject}`);
    process.exit(2);
  }
  const count = snapshot(path).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `mutation-prove-rust-template-auth: ${m.id}'s anchor occurs ${count} times in ${path}; aborting`,
    );
    process.exit(2);
  }
}

// Green baseline on a clean tree, else every verdict below is noise. The
// build-only check must pass too, or no row's build check could mean anything.
assertTreeClean(REPO_ROOT, 'baseline');
const baseBuild = cargoExit(CARGO_BUILD);
if (baseBuild === null) process.exit(2);
if (baseBuild !== 0) {
  console.error(
    `mutation-prove-rust-template-auth: baseline does not compile (exit ${baseBuild}); fix the tree first`,
  );
  process.exit(2);
}
const base = cargoExit(CARGO_TEST);
if (base === null) process.exit(2);
if (base !== 0) {
  console.error(
    `mutation-prove-rust-template-auth: baseline RED (exit ${base}); fix the tree first`,
  );
  process.exit(2);
}
console.log('mutation-prove-rust-template-auth: baseline green');

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
    build = cargoExit(CARGO_BUILD);
    if (build === 0) code = cargoExit(CARGO_TEST);
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
  `mutation-prove-rust-template-auth: ${MUTATIONS.length - failed}/${MUTATIONS.length} behaved as required`,
);
process.exit(failed === 0 ? 0 : 1);
