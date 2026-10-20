#!/usr/bin/env node
/**
 * Mutation prover for the Rust zone-function template's REPLAY rules
 * (templates/rust/src/auth): every rule that makes a zone token single-use is
 * caught by a Rust test when it is removed or loosened. It sits beside
 * `mutation-prove-2051-rust-verifier.mjs`, which proves the rest of the check.
 *
 * The tests run the shared token vectors
 * (packages/grpc/testdata/z7-token-vectors.json), its single cases AND its
 * `sequences` (several tokens presented to one verifier at stated clock
 * readings), and assert the REASON each refusal carries, so a row whose
 * mutation leaves a step refused for a different reason still reds.
 *
 * Each row plants one textual mutation (anchor EXACTLY ONCE in its subject,
 * via `lib/mutation-harness.mjs`, which marks residue and restores
 * byte-identically) and runs the row's `cargo test`, graded by EXIT CODE only:
 *
 *   J*  the jti claim (token.rs, replay.rs): a token with no jti refused, the
 *       format checked, both length bounds, the base64url alphabet.
 *   R*  the replay rule (replay.rs, auth.rs): a seen token refused; the verdict
 *       not dropped; a token recorded only after every other check passed; the
 *       entry kept until exp + skew, not less and not for ever; purged per
 *       entry; the (iss, jti) key; a poisoned set failing closed.
 *   C*  the cap (replay.rs): enforced, exact, never evicting a seen token, a
 *       replay reported as a replay even when full, a refused token not
 *       recorded, the default the vectors state.
 *   L*  the full-set warning (auth.rs): reported, and not on every call.
 *   W*  `Config::seen_capacity` reaching the check (rpc/mod.rs).
 *   N*  negative control: a change that must be tolerated, so the suite must
 *       stay GREEN.
 *
 * A CANARY runs first: a mutation that makes every valid token a replay must
 * go red, or the harness cannot see red and every green below is noise.
 * A row counts only if the mutated tree COMPILES (a build-only `cargo test
 * --no-run` first); one that does not is NOT-COMPILED and fails the prover.
 *
 * NOT A JS TEST SUITE: the guards are Rust tests. Path-listed in
 * `NON_JS_TEST_SUITE_PROVERS` (`lib/prover-lane.mjs`); spawns only `cargo`,
 * run in `templates/rust` (whose rust-toolchain.toml picks the toolchain),
 * with a PRIVATE TMPDIR (removed on exit) so a test never leaves anything in a
 * shared temp directory.
 *
 *   node scripts/mutation-prove-2510-rust-verifier.mjs
 *
 * Exit 0 = every row behaved as required; 1 = a row did not (a guard is
 * decoration, the negative control reddened, or a mutation did not compile);
 * 2 = the prover itself could not run (anchor drift, red baseline, canary
 * green, missing tool). Never parses output.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const NAME = 'mutation-prove-2510-rust-verifier';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The crate (the command's cwd), not a mutation subject.
const TEMPLATE_CRATE = `${REPO_ROOT}/templates/rust`;
const TOKEN = resolve(REPO_ROOT, 'templates/rust/src/auth/token.rs');
const REPLAY = resolve(REPO_ROOT, 'templates/rust/src/auth/replay.rs');
const AUTH = resolve(REPO_ROOT, 'templates/rust/src/auth.rs');
const SERVER = resolve(REPO_ROOT, 'templates/rust/src/rpc/mod.rs');
const PROVER = {
  subjects: {
    token: TOKEN,
    replay: REPLAY,
    auth: AUTH,
    server: SERVER,
  },
};

// The test target and filter each row runs.
const AUTH_TESTS = ['--lib', 'auth::'];
const RPC_TESTS = ['--lib', 'rpc::'];

// A private scratch directory for the tests' temp_dir(): nothing is written to
// a shared temp directory, and what was written is removed when the prover
// exits, however it exits.
const SCRATCH = mkdtempSync(join(tmpdir(), 'knext-prove-2510-rust-'));
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }));

const cargoTest = (target) => ['cargo', 'test', '--locked', ...target];
// The same target compiled with its tests, running nothing.
const cargoBuild = (target) => ['cargo', 'test', '--locked', '--no-run', target[0], target[1]];

const CHECK_CALL =
  '        claims.check(now, &self.cfg.issuer, &self.cfg.audience, procedure, mode)?;\n';
const EXP_SKEW = '            claims.exp.saturating_add(CLOCK_SKEW_SECS),\n';
const REPLAY_IF =
  '        if set.entries.contains_key(&key) {\n            return Err(AuthError::Replayed);\n        }\n';
const FULL_IF =
  '        if set.entries.len() >= set.capacity {\n            return Err(AuthError::SeenSetFull);\n        }\n';

// Every replacement ends in '\n', so the harness puts its residue marker on a
// line of its own rather than swallowing the line after the anchor.
const MUTATIONS = [
  // ── J: the jti claim ──────────────────────────────────────────────────────
  {
    id: 'J1',
    claim: 'a token with no jti is not refused as missing-jti (it fails later, or is accepted)',
    subject: 'token',
    anchor: '    if payload.get("jti").is_none() {\n',
    replacement: '    if payload.get("jti").is_none() && false {\n',
  },
  {
    id: 'J2',
    claim: 'the jti format is not checked (too short, too long, not base64url)',
    subject: 'token',
    anchor: '    if !valid_jti(&jti) {\n',
    replacement: '    if false && !valid_jti(&jti) {\n',
  },
  {
    id: 'J3',
    claim: 'a jti shorter than 22 characters (128 bits) is accepted',
    subject: 'replay',
    anchor: '    (MIN_JTI_CHARS..=MAX_JTI_CHARS).contains(&jti.len())\n',
    replacement: '    jti.len() <= MAX_JTI_CHARS\n',
  },
  {
    id: 'J4',
    claim: 'a jti longer than 64 characters is accepted (an entry has no size bound)',
    subject: 'replay',
    anchor: '    (MIN_JTI_CHARS..=MAX_JTI_CHARS).contains(&jti.len())\n',
    replacement: '    jti.len() >= MIN_JTI_CHARS\n',
  },
  {
    id: 'J5',
    claim: 'a jti with characters outside the base64url alphabet is accepted',
    subject: 'replay',
    anchor: "            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')\n",
    replacement: '            .all(|b| b != 0)\n',
  },
  {
    id: 'J6',
    claim: 'the shortest allowed jti is 21 characters (the bound is off by one)',
    subject: 'replay',
    anchor: 'pub const MIN_JTI_CHARS: usize = 22;\n',
    replacement: 'pub const MIN_JTI_CHARS: usize = 21;\n',
  },
  // ── R: the replay rule ────────────────────────────────────────────────────
  {
    id: 'R1',
    claim: 'a token that was already accepted is accepted again',
    subject: 'replay',
    anchor: REPLAY_IF,
    replacement:
      '        if set.entries.contains_key(&key) && false {\n            return Err(AuthError::Replayed);\n        }\n',
  },
  {
    id: 'R2',
    claim:
      'the replay verdict is dropped by the verifier: the set records, but the replay is served',
    subject: 'auth',
    anchor: '            return Err(err);\n        }\n        Ok(Caller {\n',
    replacement: '            let _ = err;\n        }\n        Ok(Caller {\n',
  },
  {
    id: 'R3',
    claim: 'a token is recorded BEFORE the other checks, so a refused token burns its jti',
    subject: 'auth',
    anchor: CHECK_CALL,
    replacement: `        let _ = self.seen.admit(&self.issuer, &claims.jti, claims.exp.saturating_add(CLOCK_SKEW_SECS), now);\n${CHECK_CALL}`,
  },
  {
    id: 'R4',
    claim: 'an entry is forgotten at exp, not exp + skew: a replay in the skew window gets through',
    subject: 'auth',
    anchor: EXP_SKEW,
    replacement: '            claims.exp,\n',
  },
  {
    id: 'R5',
    claim: 'an entry is kept far past exp + skew: expired entries keep their place',
    subject: 'auth',
    anchor: EXP_SKEW,
    replacement: '            claims.exp.saturating_add(CLOCK_SKEW_SECS + 3600),\n',
  },
  {
    id: 'R6',
    claim: 'an entry whose second has come is kept one more second (purge off by one)',
    subject: 'replay',
    anchor: '            if *due.key() > now {\n',
    replacement: '            if *due.key() >= now {\n',
  },
  {
    id: 'R7',
    claim: 'the set is never purged',
    subject: 'replay',
    anchor: '        set.purge(now);\n',
    replacement: '        let _ = now;\n',
  },
  {
    id: 'R8',
    claim: 'a purge forgets every entry, not only the expired ones',
    subject: 'replay',
    anchor: '            if *due.key() > now {\n',
    replacement: '            if false {\n',
  },
  {
    id: 'R9',
    claim: 'the issuer is not part of the key: one jti is one token across issuers',
    subject: 'replay',
    anchor: '            iss: Arc::clone(iss),\n',
    replacement: '            iss: Arc::from(""),\n',
  },
  {
    id: 'R10',
    claim: 'a poisoned set is used as if nothing happened (fails open)',
    subject: 'replay',
    anchor: '            .map_err(|_: PoisonError<_>| AuthError::SeenSetFull)?;\n',
    replacement: '            .unwrap_or_else(PoisonError::into_inner);\n',
  },
  // ── C: the cap ────────────────────────────────────────────────────────────
  {
    id: 'C1',
    claim: 'the cap is not enforced',
    subject: 'replay',
    anchor: FULL_IF,
    replacement: '        if false {\n            return Err(AuthError::SeenSetFull);\n        }\n',
  },
  {
    id: 'C2',
    claim: 'the cap is off by one (one more token than the cap is admitted)',
    subject: 'replay',
    anchor: FULL_IF,
    replacement:
      '        if set.entries.len() > set.capacity {\n            return Err(AuthError::SeenSetFull);\n        }\n',
  },
  {
    id: 'C3',
    claim: 'a full set evicts an entry to make room instead of refusing the new token',
    subject: 'replay',
    anchor: FULL_IF,
    replacement:
      '        if set.entries.len() >= set.capacity {\n            if let Some(old) = set.entries.keys().next().cloned() {\n                set.entries.remove(&old);\n            }\n        }\n',
  },
  {
    id: 'C4',
    claim: 'a full set reports a seen token as full, not as a replay (the order of the two checks)',
    subject: 'replay',
    anchor: REPLAY_IF + FULL_IF,
    replacement: FULL_IF + REPLAY_IF,
  },
  {
    id: 'C5',
    claim: 'a token refused because the set is full is recorded anyway',
    subject: 'replay',
    anchor: FULL_IF,
    replacement:
      '        if set.entries.len() >= set.capacity {\n            set.entries.insert(key.clone(), forget_at);\n            return Err(AuthError::SeenSetFull);\n        }\n',
  },
  {
    id: 'C6',
    claim: 'the default cap is not the one the vectors state',
    subject: 'replay',
    anchor: 'pub const DEFAULT_SEEN_CAPACITY: usize = 65_536;\n',
    replacement: 'pub const DEFAULT_SEEN_CAPACITY: usize = 1_024;\n',
  },
  {
    id: 'C7',
    claim: 'a zero capacity means a set of zero (every token refused), not the default',
    subject: 'replay',
    anchor: '        let capacity = if capacity == 0 {\n',
    replacement: '        let capacity = if capacity == usize::MAX {\n',
  },
  // ── L: the full-set warning ───────────────────────────────────────────────
  {
    id: 'L1',
    claim: 'a full set is never reported',
    subject: 'auth',
    anchor: '                self.warn_full(now);\n',
    replacement: '                let _ = now;\n',
  },
  {
    id: 'L2',
    claim: 'a full set is reported on every refusal (no rate limit)',
    subject: 'auth',
    anchor:
      '        if (last == i64::MIN || now.saturating_sub(last) >= FULL_WARNING_EVERY_SECS)\n',
    replacement:
      '        if (last == i64::MIN || true || now.saturating_sub(last) >= FULL_WARNING_EVERY_SECS)\n',
  },
  // ── W: wiring ─────────────────────────────────────────────────────────────
  {
    id: 'W1',
    claim: 'new() drops Config::seen_capacity (the knob does nothing)',
    subject: 'server',
    tests: RPC_TESTS,
    anchor: '        seen_capacity: cfg.seen_capacity,\n',
    replacement: '        seen_capacity: 0,\n',
  },
  // ── N: negative control ───────────────────────────────────────────────────
  {
    id: 'N1',
    expect: 'green',
    claim: 'pre-sizing the entries map is tolerated',
    subject: 'replay',
    anchor: '            entries: HashMap::new(),\n',
    replacement: '            entries: HashMap::with_capacity(16),\n',
  },
].map((m) => ({ expect: 'red', tests: AUTH_TESTS, ...m }));

const CANARY = {
  id: 'canary',
  claim: 'every valid token is reported as a replay',
  subject: 'auth',
  anchor: '        Ok(Caller {\n            subject: claims.sub,\n',
  replacement:
    '        if true {\n            return Err(AuthError::Replayed);\n        }\n        Ok(Caller {\n            subject: claims.sub,\n',
  tests: AUTH_TESTS,
};

// Returns the command's exit code, or null if cargo could not be run. Never
// exits here: a caller holding a mutation must restore it first.
function cargoExit(command) {
  const [bin, ...args] = command;
  const r = spawnSync(bin, args, {
    cwd: TEMPLATE_CRATE,
    env: { ...process.env, CARGO_TERM_COLOR: 'never', TMPDIR: SCRATCH },
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 900_000,
  });
  if (r.error || r.status === null) {
    console.error(`${NAME}: cannot run ${bin}: ${r.error?.message ?? r.signal}`);
    return null;
  }
  return r.status;
}

declareMutations(MUTATIONS.length);
console.log(`${NAME}: ${MUTATIONS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of [CANARY, ...MUTATIONS]) {
  const path = PROVER.subjects[m.subject];
  if (path === undefined) {
    console.error(`${NAME}: ${m.id} names no subject ${m.subject}`);
    process.exit(2);
  }
  const count = snapshot(path).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(`${NAME}: ${m.id}'s anchor occurs ${count} times in ${path}; aborting`);
    process.exit(2);
  }
}

// Green baseline on a clean tree for every target a row runs, else every
// verdict below is noise.
assertTreeClean(REPO_ROOT, 'baseline');
for (const target of [AUTH_TESTS, RPC_TESTS]) {
  const build = cargoExit(cargoBuild(target));
  if (build === null) process.exit(2);
  if (build !== 0) {
    console.error(`${NAME}: baseline does not compile (exit ${build}); fix the tree first`);
    process.exit(2);
  }
  const base = cargoExit(cargoTest(target));
  if (base === null) process.exit(2);
  if (base !== 0) {
    console.error(`${NAME}: baseline RED (${target.join(' ')}, exit ${base}); fix the tree first`);
    process.exit(2);
  }
}
console.log(`${NAME}: baseline green`);

// One planted mutation: build it, test it, restore it whatever happens.
function plant(m) {
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
  return { build, code };
}

// Step 0: the harness must see red before any green is trusted.
const canary = plant(CANARY);
if (canary.build === null || canary.code === null) process.exit(2);
if (canary.build !== 0 || canary.code === 0) {
  console.error(
    `${NAME}: the canary mutation left the guard GREEN (build ${canary.build}, test ${canary.code}); the harness cannot see red`,
  );
  process.exit(2);
}
console.log(`${NAME}: step 0 ok: the harness sees red (canary exit=${canary.code})`);

let failed = 0;
for (const m of MUTATIONS) {
  const { build, code } = plant(m);
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

console.log(`${NAME}: ${MUTATIONS.length - failed}/${MUTATIONS.length} behaved as required`);
process.exit(failed === 0 ? 0 : 1);
