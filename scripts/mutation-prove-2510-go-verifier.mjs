#!/usr/bin/env node
/**
 * Mutation prover for the Go zone-function template's REPLAY rules
 * (templates/go/internal/auth): every rule that makes a zone token single-use
 * is caught by a Go test when it is removed or loosened. It sits beside
 * `mutation-prove-2051-go-verifier.mjs`, which proves the rest of the check.
 *
 * The tests run the shared token vectors
 * (packages/grpc/testdata/z7-token-vectors.json), its single cases AND its
 * `sequences` (several tokens presented to one verifier at stated clock
 * readings), and assert the REASON each refusal carries, so a row whose
 * mutation leaves a step refused for a different reason still reds.
 *
 * Each row plants one textual mutation (anchor EXACTLY ONCE in its subject,
 * via `lib/mutation-harness.mjs`, which marks residue and restores
 * byte-identically) and runs `go test` over the row's packages, graded by
 * EXIT CODE only:
 *
 *   J*  the jti claim (token.go, replay.go): a token with no jti refused, the
 *       format checked, both length bounds, the base64url alphabet.
 *   R*  the replay rule (replay.go, verifier.go): a seen token refused; the
 *       verdict not dropped; a token recorded only after every other check
 *       passed; the entry kept until exp + skew, not less and not for ever;
 *       purged per entry; the (iss, jti) key; one admission under concurrency.
 *   C*  the cap (replay.go): enforced, exact, never evicting a seen token,
 *       a replay reported as a replay even when full, a refused token not
 *       recorded, the default the vectors state.
 *   L*  the full-set warning (verifier.go): reported, and not on every call.
 *   E*  what a client sees (auth.go): a full set is ResourceExhausted, a replay
 *       stays Unauthenticated.
 *   W*  Config.SeenCapacity reaching the check (rpc.go).
 *   N*  negative control: a change that must be tolerated, so the suite must
 *       stay GREEN.
 *
 * A CANARY runs first: a mutation that makes every valid token a replay must
 * go red, or the harness cannot see red and every green below is noise.
 * A row counts only if the mutated tree COMPILES (a build-only `go test -run
 * ^$` first); one that does not is NOT-COMPILED and fails the prover.
 *
 * NOT A JS TEST SUITE: the guards are Go tests. Path-listed in
 * `NON_JS_TEST_SUITE_PROVERS` (`lib/prover-lane.mjs`); spawns only `go`, run
 * in `templates/go` with GOTOOLCHAIN=auto, a PRIVATE TMPDIR and GOTMPDIR
 * (removed on exit) so a build or a test never leaves anything in a shared
 * temp directory.
 *
 *   node scripts/mutation-prove-2510-go-verifier.mjs
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

const NAME = 'mutation-prove-2510-go-verifier';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the command's cwd), not a mutation subject.
const TEMPLATE_MODULE = `${REPO_ROOT}/templates/go`;
const TOKEN = resolve(REPO_ROOT, 'templates/go/internal/auth/token.go');
const REPLAY = resolve(REPO_ROOT, 'templates/go/internal/auth/replay.go');
const VERIFIER = resolve(REPO_ROOT, 'templates/go/internal/auth/verifier.go');
const AUTH = resolve(REPO_ROOT, 'templates/go/internal/auth/auth.go');
const SERVER = resolve(REPO_ROOT, 'templates/go/internal/rpc/rpc.go');
const PROVER = {
  subjects: {
    token: TOKEN,
    replay: REPLAY,
    verifier: VERIFIER,
    auth: AUTH,
    server: SERVER,
  },
};

const AUTH_PKG = ['./internal/auth/'];
const RPC_PKG = ['./internal/rpc/'];

// A private scratch directory for go's build cache temp files and the tests'
// t.TempDir(): nothing is written to a shared temp directory, and what was
// written is removed when the prover exits, however it exits.
const SCRATCH = mkdtempSync(join(tmpdir(), 'knext-prove-2510-go-'));
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }));

// -count=1: never trust a cached pass for a mutated tree.
const goTest = (pkgs, race = false) => [
  'go',
  'test',
  '-count=1',
  '-timeout',
  '180s',
  ...(race ? ['-race'] : []),
  ...pkgs,
];
// The same packages, compiled with their tests (and go test's vet subset),
// running no test.
const goBuild = (pkgs, race = false) => [
  'go',
  'test',
  '-count=1',
  '-run',
  '^$',
  ...(race ? ['-race'] : []),
  ...pkgs,
];

const ADMIT_CALL =
  '\tif err := v.seen.admit(v.cfg.Issuer, c.jti, c.exp+seenSkew, now); err != nil {\n';
const CHECK_CALL =
  '\tif err := c.check(now, v.cfg.Issuer, v.cfg.Audience, procedure, mode); err != nil {\n';

// Every replacement ends in '\n', so the harness puts its residue marker on a
// line of its own rather than swallowing the line after the anchor.
const MUTATIONS = [
  // ── J: the jti claim ──────────────────────────────────────────────────────
  {
    id: 'J1',
    claim: 'a token with no jti is not refused as missing-jti (it fails later, or is accepted)',
    subject: 'token',
    anchor: '\tif _, ok := payload["jti"]; !ok {\n',
    replacement: '\tif _, ok := payload["jti"]; !ok && false {\n',
  },
  {
    id: 'J2',
    claim: 'the jti format is not checked (too short, too long, not base64url)',
    subject: 'token',
    anchor: '\tif !validJTI(c.jti) {\n',
    replacement: '\tif false && !validJTI(c.jti) {\n',
  },
  {
    id: 'J3',
    claim: 'a jti shorter than 22 characters (128 bits) is accepted',
    subject: 'replay',
    anchor: '\tif len(jti) < MinJTIChars || len(jti) > MaxJTIChars {\n',
    replacement: '\tif len(jti) > MaxJTIChars {\n',
  },
  {
    id: 'J4',
    claim: 'a jti longer than 64 characters is accepted (an entry has no size bound)',
    subject: 'replay',
    anchor: '\tif len(jti) < MinJTIChars || len(jti) > MaxJTIChars {\n',
    replacement: '\tif len(jti) < MinJTIChars {\n',
  },
  {
    id: 'J5',
    claim: 'a jti with characters outside the base64url alphabet is accepted',
    subject: 'replay',
    anchor:
      "\t\tif !('A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_') {\n",
    replacement: '\t\tif c == 0 {\n',
  },
  {
    id: 'J6',
    claim: 'the shortest allowed jti is 21 characters (the bound is off by one)',
    subject: 'replay',
    anchor: '\tMinJTIChars = 22\n',
    replacement: '\tMinJTIChars = 21\n',
  },
  // ── R: the replay rule ────────────────────────────────────────────────────
  {
    id: 'R1',
    claim: 'a token that was already accepted is accepted again',
    subject: 'replay',
    anchor: '\tif _, seen := s.entries[k]; seen {\n',
    replacement: '\tif _, seen := s.entries[k]; seen && false {\n',
  },
  {
    id: 'R2',
    claim:
      'the replay verdict is dropped by the verifier: the set records, but the replay is served',
    subject: 'verifier',
    anchor: ADMIT_CALL,
    replacement:
      '\tif err := v.seen.admit(v.cfg.Issuer, c.jti, c.exp+seenSkew, now); err != nil && false {\n',
  },
  {
    id: 'R3',
    claim: 'a token is recorded BEFORE the other checks, so a refused token burns its jti',
    subject: 'verifier',
    anchor: '\tnow := v.cfg.Now().Unix()\n' + CHECK_CALL,
    replacement:
      '\tnow := v.cfg.Now().Unix()\n\t_ = v.seen.admit(v.cfg.Issuer, c.jti, c.exp+seenSkew, now)\n' +
      CHECK_CALL,
  },
  {
    id: 'R4',
    claim: 'an entry is forgotten at exp, not exp + skew: a replay in the skew window gets through',
    subject: 'verifier',
    anchor: ADMIT_CALL,
    replacement: '\tif err := v.seen.admit(v.cfg.Issuer, c.jti, c.exp, now); err != nil {\n',
  },
  {
    id: 'R5',
    claim: 'an entry is kept far past exp + skew: expired entries keep their place',
    subject: 'verifier',
    anchor: ADMIT_CALL,
    replacement:
      '\tif err := v.seen.admit(v.cfg.Issuer, c.jti, c.exp+seenSkew+3600, now); err != nil {\n',
  },
  {
    id: 'R6',
    claim: 'an entry whose second has come is kept one more second (purge off by one)',
    subject: 'replay',
    anchor: '\t\tif at <= now {\n',
    replacement: '\t\tif at < now {\n',
  },
  {
    id: 'R7',
    claim: 'the set is never purged',
    subject: 'replay',
    anchor: '\ts.purge(now)\n',
    replacement: '\t_ = now\n',
  },
  {
    id: 'R8',
    claim: 'a purge forgets every entry, not only the expired ones',
    subject: 'replay',
    anchor: '\t\tif at <= now {\n',
    replacement: '\t\tif at <= now || len(s.entries) > 0 {\n',
  },
  {
    id: 'R9',
    claim: 'the issuer is not part of the key: one jti is one token across issuers',
    subject: 'replay',
    anchor: '\tk := seenKey{iss, jti}\n',
    replacement: '\tk := seenKey{"", jti}\n',
  },
  {
    id: 'R10',
    claim: 'the set is not locked: concurrent uses of one token can all be admitted',
    subject: 'replay',
    race: true,
    anchor: '\ts.mu.Lock()\n\tdefer s.mu.Unlock()\n\ts.purge(now)\n',
    replacement: '\ts.purge(now)\n',
    pkgs: AUTH_PKG,
  },
  // ── C: the cap ────────────────────────────────────────────────────────────
  {
    id: 'C1',
    claim: 'the cap is not enforced',
    subject: 'replay',
    anchor: '\tif len(s.entries) >= s.capacity {\n',
    replacement: '\tif false {\n',
  },
  {
    id: 'C2',
    claim: 'the cap is off by one (one more token than the cap is admitted)',
    subject: 'replay',
    anchor: '\tif len(s.entries) >= s.capacity {\n',
    replacement: '\tif len(s.entries) > s.capacity {\n',
  },
  {
    id: 'C3',
    claim: 'a full set evicts an entry to make room instead of refusing the new token',
    subject: 'replay',
    anchor: '\tif len(s.entries) >= s.capacity {\n\t\treturn ErrSeenSetFull\n\t}\n',
    replacement:
      '\tif len(s.entries) >= s.capacity {\n\t\tfor old := range s.entries {\n\t\t\tdelete(s.entries, old)\n\t\t\tbreak\n\t\t}\n\t}\n',
  },
  {
    id: 'C4',
    claim: 'a full set reports a seen token as full, not as a replay (the order of the two checks)',
    subject: 'replay',
    anchor:
      '\tif _, seen := s.entries[k]; seen {\n\t\treturn ErrReplayed\n\t}\n\tif len(s.entries) >= s.capacity {\n\t\treturn ErrSeenSetFull\n\t}\n',
    replacement:
      '\tif len(s.entries) >= s.capacity {\n\t\treturn ErrSeenSetFull\n\t}\n\tif _, seen := s.entries[k]; seen {\n\t\treturn ErrReplayed\n\t}\n',
  },
  {
    id: 'C5',
    claim: 'a token refused because the set is full is recorded anyway',
    subject: 'replay',
    anchor: '\tif len(s.entries) >= s.capacity {\n\t\treturn ErrSeenSetFull\n\t}\n',
    replacement:
      '\tif len(s.entries) >= s.capacity {\n\t\ts.entries[k] = forgetAt\n\t\treturn ErrSeenSetFull\n\t}\n',
  },
  {
    id: 'C6',
    claim: 'the default cap is not the one the vectors state',
    subject: 'replay',
    anchor: '\tDefaultSeenCapacity = 65536\n',
    replacement: '\tDefaultSeenCapacity = 1024\n',
  },
  {
    id: 'C7',
    claim: 'a zero capacity means a set of zero (every token refused), not the default',
    subject: 'replay',
    anchor: '\tif capacity <= 0 {\n\t\tcapacity = DefaultSeenCapacity\n\t}\n',
    replacement: '\tif capacity < 0 {\n\t\tcapacity = DefaultSeenCapacity\n\t}\n',
  },
  // ── L: the full-set warning ───────────────────────────────────────────────
  {
    id: 'L1',
    claim: 'a full set is never reported',
    subject: 'verifier',
    anchor: '\t\t\tv.warnFull(now)\n',
    replacement: '\t\t\t_ = now\n',
  },
  {
    id: 'L2',
    claim: 'a full set is reported on every refusal (no rate limit)',
    subject: 'verifier',
    anchor:
      '\tif (last == 0 || now-last >= fullWarningEvery) && v.fullLoggedAt.CompareAndSwap(last, now) {\n',
    replacement: '\tif v.fullLoggedAt.CompareAndSwap(last, now) || true {\n',
  },
  // ── E: the code a client sees ─────────────────────────────────────────────
  {
    id: 'E1',
    claim: 'a full replay set answers unauthenticated, as if the caller had done something wrong',
    subject: 'auth',
    anchor: '\t\t\t\tif errors.Is(err, ErrSeenSetFull) {\n',
    replacement: '\t\t\t\tif false && errors.Is(err, ErrSeenSetFull) {\n',
  },
  {
    id: 'E2',
    claim:
      'a replay is answered resource-exhausted too (a client is told to retry what it must not)',
    subject: 'auth',
    anchor: '\t\t\t\tif errors.Is(err, ErrSeenSetFull) {\n',
    replacement: '\t\t\t\tif errors.Is(err, ErrSeenSetFull) || errors.Is(err, ErrReplayed) {\n',
  },
  // ── W: wiring ─────────────────────────────────────────────────────────────
  {
    id: 'W1',
    claim: 'rpc.New drops Config.SeenCapacity (the knob does nothing)',
    subject: 'server',
    pkgs: RPC_PKG,
    anchor: '\t\tSeenCapacity: cfg.SeenCapacity,\n',
    replacement: '\t\tSeenCapacity: 0,\n',
  },
  // ── N: negative control ───────────────────────────────────────────────────
  {
    id: 'N1',
    expect: 'green',
    claim: 'pre-sizing the entries map is tolerated',
    subject: 'replay',
    anchor: '\t\tentries:  make(map[seenKey]int64),\n',
    replacement: '\t\tentries:  make(map[seenKey]int64, 16),\n',
  },
].map((m) => ({ expect: 'red', pkgs: AUTH_PKG, race: false, ...m }));

const CANARY = {
  id: 'canary',
  claim: 'every valid token is reported as a replay',
  subject: 'verifier',
  anchor: '\treturn Caller{Subject: c.sub, Zone: c.iss}, nil\n',
  replacement: '\treturn Caller{}, ErrReplayed\n',
  pkgs: AUTH_PKG,
  race: false,
};

// Returns the command's exit code, or null if go could not be run. Never exits
// here: a caller holding a mutation must restore it first.
function goExit(command) {
  const [bin, ...args] = command;
  const r = spawnSync(bin, args, {
    cwd: TEMPLATE_MODULE,
    env: { ...process.env, GOTOOLCHAIN: 'auto', TMPDIR: SCRATCH, GOTMPDIR: SCRATCH },
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 600_000,
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

// Green baseline on a clean tree over every package a row runs (and under
// -race, which one row needs), else every verdict below is noise.
const ALL_PKGS = [...AUTH_PKG, ...RPC_PKG];
assertTreeClean(REPO_ROOT, 'baseline');
for (const race of [false, true]) {
  const baseBuild = goExit(goBuild(ALL_PKGS, race));
  if (baseBuild === null) process.exit(2);
  if (baseBuild !== 0) {
    console.error(`${NAME}: baseline does not compile (exit ${baseBuild}); fix the tree first`);
    process.exit(2);
  }
  const base = goExit(goTest(ALL_PKGS, race));
  if (base === null) process.exit(2);
  if (base !== 0) {
    console.error(`${NAME}: baseline RED (exit ${base}, race=${race}); fix the tree first`);
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
    build = goExit(goBuild(m.pkgs, m.race));
    if (build === 0) code = goExit(goTest(m.pkgs, m.race));
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
