#!/usr/bin/env node
/**
 * Mutation prover for the Rust zone-function template's identity-token
 * verifier (templates/rust/src/auth): every check that refuses a token is
 * caught by a Rust test when it is removed or loosened.
 *
 * The tests run every case of the shared token vectors
 * (packages/grpc/testdata/z7-token-vectors.json) and assert the REASON each
 * negative case is refused for, so a row whose mutation leaves the case
 * refused for a different reason still reds.
 *
 * Each row plants one textual mutation (anchor EXACTLY ONCE in its subject,
 * via `lib/mutation-harness.mjs`, which marks residue and restores
 * byte-identically) and runs the row's `cargo test`, graded by EXIT CODE only:
 *
 *   P*  parsing (src/auth/token.rs): segment count, canonical unpadded
 *       base64url, duplicate members, the closed header, typ, an empty kid,
 *       alg, an unknown kid, the signature, a missing or null claim, an
 *       integer claim.
 *   C*  the claims (src/auth/token.rs): lifetime (both bounds), expiry, the
 *       skew on exp and iat, issuer, audience, method, the AUTH_USER subject,
 *       and AUTH_PUBLIC not demanding one.
 *   J*  the JWKS (src/auth/jwks.rs): kty, crv, kid derived from the key, a
 *       removed or unparseable JWKS not served from cache, the reload on
 *       change and on the interval, the bounded read, a set with no keys.
 *       (A key that is not 32 bytes cannot become a VerifyingKey at all: the
 *       type holds that check, so there is no row for it.)
 *   V*  the verifier (src/auth.rs): issuer and audience configured, an RPC
 *       with no auth option refused, the verified caller replacing any other
 *       in the request.
 *   T*  the contract table (src/auth/policy.rs): an RPC's option changed, an
 *       unknown RPC given one.
 *   W*, M*  the wiring of the issuer (src/rpc/mod.rs) and its env
 *       (src/main.rs).
 *   N*  negative control: a re-read interval shorter than the contract's
 *       bound is tolerated, so the suite must stay GREEN.
 *
 * A row counts only if the mutated tree COMPILES: before its test run, each
 * row must pass a build-only `cargo test --no-run` of the same target. A row
 * that does not compile is reported NOT-COMPILED and fails the prover.
 *
 * NOT A JS TEST SUITE: the guards are Rust tests, so there is no vitest
 * runner to resolve. Path-listed in `NON_JS_TEST_SUITE_PROVERS`
 * (`lib/prover-lane.mjs`); spawns only `cargo`, run in `templates/rust`
 * (whose rust-toolchain.toml picks the toolchain).
 *
 *   node scripts/mutation-prove-2051-rust-verifier.mjs
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
// The crate (the command's cwd), not a mutation subject.
const TEMPLATE_CRATE = `${REPO_ROOT}/templates/rust`;
const TOKEN = resolve(REPO_ROOT, 'templates/rust/src/auth/token.rs');
const JWKS = resolve(REPO_ROOT, 'templates/rust/src/auth/jwks.rs');
const AUTH = resolve(REPO_ROOT, 'templates/rust/src/auth.rs');
const POLICY = resolve(REPO_ROOT, 'templates/rust/src/auth/policy.rs');
const SERVER = resolve(REPO_ROOT, 'templates/rust/src/rpc/mod.rs');
const MAIN = resolve(REPO_ROOT, 'templates/rust/src/main.rs');
const PROVER = {
  subjects: {
    token: TOKEN,
    jwks: JWKS,
    auth: AUTH,
    policy: POLICY,
    server: SERVER,
    main: MAIN,
  },
};

// The test target and filter each row runs: the token check's unit tests, the
// server's, or the binary's.
const AUTH_TESTS = ['--lib', 'auth::'];
const RPC_TESTS = ['--lib', 'rpc::'];
const BIN_TESTS = ['--bin', 'function'];

const cargoTest = (target) => ['cargo', 'test', '--locked', ...target];
// The same target compiled with its tests, running nothing.
const cargoBuild = (target) => ['cargo', 'test', '--locked', '--no-run', target[0], target[1]];

// Every replacement ends in '\n', so the harness puts its residue marker on a
// line of its own rather than swallowing the line after the anchor.
const MUTATIONS = [
  // ── P: parsing ────────────────────────────────────────────────────────────
  {
    id: 'P1',
    claim: 'a token with fewer than three segments is padded, not refused',
    subject: 'token',
    anchor:
      '    let [h, p, s] = segments[..] else {\n        return Err(malformed(format!("{} segments, want 3", segments.len())));\n    };\n',
    replacement:
      '    let pad = |i: usize| segments.get(i).copied().unwrap_or("");\n    let (h, p, s) = (pad(0), pad(1), pad(2));\n',
  },
  {
    id: 'P2',
    claim: 'padded or non-canonical base64url decodes',
    subject: 'token',
    anchor: '    URL_SAFE_NO_PAD\n        .decode(s)\n',
    replacement:
      '    base64::engine::GeneralPurpose::new(\n        &base64::alphabet::URL_SAFE,\n        base64::engine::GeneralPurposeConfig::new()\n            .with_decode_allow_trailing_bits(true)\n            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),\n    )\n    .decode(s)\n',
  },
  {
    id: 'P3',
    claim: 'a duplicate JSON member is kept (the first value wins)',
    subject: 'token',
    anchor: '                    if members.iter().any(|(n, _)| *n == name) {\n',
    replacement:
      '                    if members.iter().any(|(n, _)| *n == name) && name.is_empty() {\n',
  },
  {
    id: 'P4',
    claim: 'the header admits a crit member',
    subject: 'token',
    anchor: '        .find(|n| !matches!(*n, "alg" | "typ" | "kid"))\n',
    replacement: '        .find(|n| !matches!(*n, "alg" | "typ" | "kid" | "crit"))\n',
  },
  {
    id: 'P5',
    claim: 'any typ is accepted',
    subject: 'token',
    anchor: '    if header.string("typ")? != "JWT" {\n',
    replacement: '    if header.string("typ")?.is_empty() {\n',
  },
  {
    id: 'P6',
    claim: 'an empty kid is looked up instead of refused as malformed',
    subject: 'token',
    anchor: '    if kid.is_empty() {\n        return Err(malformed("empty kid"));\n    }\n',
    replacement: '\n',
  },
  {
    id: 'P7',
    claim: 'an alg other than EdDSA (Ed25519, HS256) is accepted unless it is "none"',
    subject: 'token',
    anchor: '    if header.string("alg").ok() != Some("EdDSA") {\n',
    replacement: '    if header.string("alg").ok() == Some("none") {\n',
  },
  {
    id: 'P8',
    claim: 'an unknown kid falls back to any key in the JWKS',
    subject: 'token',
    anchor: '    let key = keys.get(kid).ok_or(AuthError::UnknownKid)?;\n',
    replacement:
      '    let key = keys\n        .get(kid)\n        .or_else(|| keys.values().next())\n        .ok_or(AuthError::UnknownKid)?;\n',
  },
  {
    id: 'P9',
    claim: 'the signature is not verified',
    subject: 'token',
    anchor:
      '    key.verify_strict(signing_input.as_bytes(), &signature)\n        .map_err(|_| AuthError::BadSignature)?;\n',
    replacement: '    let _ = key.verify_strict(signing_input.as_bytes(), &signature);\n',
  },
  {
    id: 'P10',
    claim: 'a missing string claim reads as empty (sub on an AUTH_PUBLIC RPC)',
    subject: 'token',
    anchor:
      '            Some(_) => Err(malformed(format!("{name:?} is not a string"))),\n            None => Err(malformed(format!("missing {name:?}"))),\n',
    replacement:
      '            Some(_) => Err(malformed(format!("{name:?} is not a string"))),\n            None => Ok(""),\n',
  },
  {
    id: 'P11',
    claim: 'a null claim reads as an empty string',
    subject: 'token',
    anchor: '            Some(_) => Err(malformed(format!("{name:?} is not a string"))),\n',
    replacement:
      '            Some(Value::Null) => Ok(""),\n            Some(_) => Err(malformed(format!("{name:?} is not a string"))),\n',
  },
  {
    id: 'P12',
    claim: 'a fractional exp is truncated to an integer',
    subject: 'token',
    anchor: '                .as_i64()\n',
    replacement: '                .as_f64()\n                .map(|f| f as i64)\n',
  },
  // ── C: the claims ─────────────────────────────────────────────────────────
  {
    id: 'C1',
    claim: 'exp - iat above 60 s is accepted',
    subject: 'token',
    anchor:
      '            || i128::from(self.exp) - i128::from(self.iat) > i128::from(MAX_TOKEN_LIFETIME_SECS)\n',
    replacement: '            || i128::from(MAX_TOKEN_LIFETIME_SECS) == 0\n',
  },
  {
    id: 'C2',
    claim: 'exp at or before iat is accepted',
    subject: 'token',
    anchor: '        if self.exp <= self.iat\n',
    replacement: '        if false\n',
  },
  {
    id: 'C3',
    claim: 'an expired token is accepted',
    subject: 'token',
    anchor: '        if i128::from(self.exp) <= i128::from(now) - i128::from(CLOCK_SKEW_SECS) {\n',
    replacement:
      '        if false && i128::from(self.exp) <= i128::from(now) - i128::from(CLOCK_SKEW_SECS) {\n',
  },
  {
    id: 'C4',
    claim: 'a token exactly at exp + skew is accepted (off by one)',
    subject: 'token',
    anchor: '        if i128::from(self.exp) <= i128::from(now) - i128::from(CLOCK_SKEW_SECS) {\n',
    replacement:
      '        if i128::from(self.exp) < i128::from(now) - i128::from(CLOCK_SKEW_SECS) {\n',
  },
  {
    id: 'C5',
    claim: 'the clock skew on exp is dropped (a token 4 s past exp is refused)',
    subject: 'token',
    anchor: '        if i128::from(self.exp) <= i128::from(now) - i128::from(CLOCK_SKEW_SECS) {\n',
    replacement: '        if i128::from(self.exp) <= i128::from(now) {\n',
  },
  {
    id: 'C6',
    claim: 'a token issued in the future is accepted',
    subject: 'token',
    anchor: '        if i128::from(self.iat) > i128::from(now) + i128::from(CLOCK_SKEW_SECS) {\n',
    replacement:
      '        if false && i128::from(self.iat) > i128::from(now) + i128::from(CLOCK_SKEW_SECS) {\n',
  },
  {
    id: 'C7',
    claim: 'the clock skew on iat is dropped (a token issued 5 s ahead is refused)',
    subject: 'token',
    anchor: '        if i128::from(self.iat) > i128::from(now) + i128::from(CLOCK_SKEW_SECS) {\n',
    replacement: '        if i128::from(self.iat) > i128::from(now) {\n',
  },
  {
    id: 'C8',
    claim: 'the issuer is not checked (wrong zone, misconfigured JWKS)',
    subject: 'token',
    anchor: '        if self.iss != issuer {\n',
    replacement: '        if self.iss.is_empty() {\n',
  },
  {
    id: 'C9',
    claim: 'the audience is not checked',
    subject: 'token',
    anchor: '        if self.aud != audience {\n',
    replacement: '        if self.aud.is_empty() {\n',
  },
  {
    id: 'C10',
    claim: 'the method is not bound to the RPC called',
    subject: 'token',
    anchor: '        if self.method != procedure {\n',
    replacement: '        if self.method.is_empty() {\n',
  },
  {
    id: 'C11',
    claim: 'an AUTH_USER RPC accepts a token with no user',
    subject: 'token',
    anchor: '        if mode == Auth::AUTH_USER && self.sub.is_empty() {\n',
    replacement: '        if mode == Auth::AUTH_USER && self.sub.is_empty() && false {\n',
  },
  {
    id: 'C12',
    claim: 'an AUTH_PUBLIC RPC demands a user too (the option is ignored)',
    subject: 'token',
    anchor: '        if mode == Auth::AUTH_USER && self.sub.is_empty() {\n',
    replacement: '        if mode != Auth::AUTH_UNSPECIFIED && self.sub.is_empty() {\n',
  },
  // ── J: the JWKS ───────────────────────────────────────────────────────────
  {
    id: 'J1',
    claim: 'a JWK of another kty is used',
    subject: 'jwks',
    anchor: '        if field("kty") != "OKP" {\n',
    replacement: '        if field("kty").is_empty() {\n',
  },
  {
    id: 'J2',
    claim: 'a JWK of another crv is used',
    subject: 'jwks',
    anchor: '        if field("crv") != "Ed25519" {\n',
    replacement: '        if field("crv").is_empty() {\n',
  },
  {
    id: 'J3',
    claim: 'a JWK whose kid is not derived from its key is used',
    subject: 'jwks',
    anchor: '        if kid != key_id(&raw) {\n',
    replacement: '        if kid.is_empty() {\n',
  },
  {
    id: 'J4',
    claim: 'a JWKS removed after it was read keeps serving its cached keys',
    subject: 'jwks',
    anchor: '        if !jwks_mounted(&self.path) {\n            return Err(AuthError::NoJwks);\n',
    replacement:
      '        if !jwks_mounted(&self.path) {\n            if let Some(Snapshot { keys: Ok(keys), .. }) = self.last.lock().unwrap().as_ref() {\n                return Ok(Arc::clone(keys));\n            }\n            return Err(AuthError::NoJwks);\n',
  },
  {
    id: 'J5',
    claim: 'a changed JWKS file is not re-read until the interval passes (no warm-pod pickup)',
    subject: 'jwks',
    anchor: '            if read.mtime == mtime && read.len == len && fresh {\n',
    replacement: '            if fresh {\n',
  },
  {
    id: 'J6',
    claim: 'the JWKS is never re-read while its mtime and size hold still',
    subject: 'jwks',
    anchor: '            if read.mtime == mtime && read.len == len && fresh {\n',
    replacement: '            if read.mtime == mtime && read.len == len {\n',
  },
  {
    id: 'J7',
    claim: 'an unparseable JWKS keeps the keys of the last good read',
    subject: 'jwks',
    anchor:
      '        *last = None;\n        let data = read_at_most(&self.path, MAX_JWKS_BYTES)?;\n        let keys = parse(&data).map(Arc::new);\n',
    replacement:
      '        let data = read_at_most(&self.path, MAX_JWKS_BYTES)?;\n        let keys = parse(&data).map(Arc::new).or_else(|e| match last.as_ref() {\n            Some(Snapshot { keys: Ok(k), .. }) => Ok(Arc::clone(k)),\n            _ => Err(e),\n        });\n',
  },
  {
    id: 'J8',
    claim: 'the JWKS read is unbounded',
    subject: 'jwks',
    anchor: '    file.take(limit + 1)\n',
    replacement: '    let limit = u64::MAX - 1;\n    file.take(limit + 1)\n',
  },
  {
    id: 'J9',
    claim: 'a JSON object with no keys array reads as an empty JWK Set',
    subject: 'jwks',
    anchor:
      '    let Some(entries) = set.get("keys").and_then(Value::as_array) else {\n        return Err(AuthError::BadJwks);\n    };\n',
    replacement:
      '    let empty = Vec::new();\n    let entries = set.get("keys").and_then(Value::as_array).unwrap_or(&empty);\n',
  },
  // ── V: the verifier ───────────────────────────────────────────────────────
  {
    id: 'V1',
    claim: 'a verifier with only one of issuer and audience set runs',
    subject: 'auth',
    anchor: '        if self.cfg.issuer.is_empty() || self.cfg.audience.is_empty() {\n',
    replacement: '        if self.cfg.issuer.is_empty() && self.cfg.audience.is_empty() {\n',
  },
  {
    id: 'V2',
    claim: 'an RPC that states no auth option is served',
    subject: 'auth',
    anchor: '        if !matches!(mode, Auth::AUTH_USER | Auth::AUTH_PUBLIC) {\n',
    replacement:
      '        if !matches!(mode, Auth::AUTH_USER | Auth::AUTH_PUBLIC | Auth::AUTH_UNSPECIFIED) {\n',
  },
  {
    id: 'V3',
    claim: 'the verified caller never reaches the service (a planted one survives)',
    subject: 'auth',
    anchor: '        req.extensions_mut().insert(caller);\n',
    replacement: '        let _ = caller;\n',
  },
  // ── T: the contract table ─────────────────────────────────────────────────
  {
    id: 'T1',
    claim: 'a USER RPC is listed as AUTH_PUBLIC',
    subject: 'policy',
    anchor: '        "/example.v1.ExampleService/PutItem" => Auth::AUTH_USER,\n',
    replacement: '        "/example.v1.ExampleService/PutItem" => Auth::AUTH_PUBLIC,\n',
  },
  {
    id: 'T2',
    claim: 'an RPC in no contract is given an auth option',
    subject: 'policy',
    anchor: '        _ => Auth::AUTH_UNSPECIFIED,\n',
    replacement: '        _ => Auth::AUTH_PUBLIC,\n',
  },
  // ── W, M: wiring and env ──────────────────────────────────────────────────
  {
    id: 'W1',
    claim: 'new() holds tokens to the audience as their issuer',
    subject: 'server',
    tests: RPC_TESTS,
    anchor: '            cfg.issuer.clone(),\n',
    replacement: '            cfg.audience.clone(),\n',
  },
  {
    id: 'M1',
    claim: "main reads the issuer from the audience's variable",
    subject: 'main',
    tests: BIN_TESTS,
    anchor: '        issuer: getenv(auth::ENV_ISSUER).unwrap_or_default(),\n',
    replacement: '        issuer: getenv(auth::ENV_AUDIENCE).unwrap_or_default(),\n',
  },
  // ── N: negative control ───────────────────────────────────────────────────
  {
    id: 'N1',
    expect: 'green',
    claim: 'a 5 s re-read interval (inside the contract bound) is tolerated',
    subject: 'auth',
    anchor: 'pub const JWKS_REREAD_INTERVAL: Duration = Duration::from_secs(10);\n',
    replacement: 'pub const JWKS_REREAD_INTERVAL: Duration = Duration::from_secs(5);\n',
  },
].map((m) => ({ expect: 'red', tests: AUTH_TESTS, ...m }));

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
      `mutation-prove-2051-rust-verifier: cannot run ${bin}: ${r.error?.message ?? r.signal}`,
    );
    return null;
  }
  return r.status;
}

declareMutations(MUTATIONS.length);
console.log(`mutation-prove-2051-rust-verifier: ${MUTATIONS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of MUTATIONS) {
  const path = PROVER.subjects[m.subject];
  if (path === undefined) {
    console.error(`mutation-prove-2051-rust-verifier: ${m.id} names no subject ${m.subject}`);
    process.exit(2);
  }
  const count = snapshot(path).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `mutation-prove-2051-rust-verifier: ${m.id}'s anchor occurs ${count} times in ${path}; aborting`,
    );
    process.exit(2);
  }
}

// Green baseline on a clean tree for every target a row runs, else every
// verdict below is noise.
assertTreeClean(REPO_ROOT, 'baseline');
for (const target of [AUTH_TESTS, RPC_TESTS, BIN_TESTS]) {
  const build = cargoExit(cargoBuild(target));
  if (build === null) process.exit(2);
  if (build !== 0) {
    console.error(
      `mutation-prove-2051-rust-verifier: baseline does not compile (exit ${build}); fix the tree first`,
    );
    process.exit(2);
  }
  const base = cargoExit(cargoTest(target));
  if (base === null) process.exit(2);
  if (base !== 0) {
    console.error(
      `mutation-prove-2051-rust-verifier: baseline RED (${target.join(' ')}, exit ${base}); fix the tree first`,
    );
    process.exit(2);
  }
}
console.log('mutation-prove-2051-rust-verifier: baseline green');

let failed = 0;
for (const m of MUTATIONS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(PROVER.subjects[m.subject]);
  let build;
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    // A mutation that does not compile is red for the wrong reason.
    build = cargoExit(cargoBuild(m.tests));
    if (build === 0) code = cargoExit(cargoTest(m.tests));
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  if (build === null || code === null) process.exit(2);
  recordMutation();
  if (build !== 0) {
    failed++;
    console.error(
      `*** NOT-COMPILED *** ${m.id} build exit=${build}: the mutated tree does not compile, so this row proves nothing — ${m.claim}`,
    );
    continue;
  }
  const ok = m.expect === 'red' ? code !== 0 : code === 0;
  if (!ok) failed++;
  const verdict = ok ? (m.expect === 'red' ? 'KILLED   ' : 'TOLERATED') : '*** SURVIVED ***';
  console.log(`${verdict} ${m.id} expect=${m.expect} exit=${code} — ${m.claim}`);
}

console.log(
  `mutation-prove-2051-rust-verifier: ${MUTATIONS.length - failed}/${MUTATIONS.length} behaved as required`,
);
process.exit(failed === 0 ? 0 : 1);
