#!/usr/bin/env node
/**
 * Mutation prover for the Go zone-function template's identity-token
 * verifier (templates/go/internal/auth): every check that refuses a token is
 * caught by a Go test when it is removed or loosened.
 *
 * The tests run every case of the shared token vectors
 * (packages/grpc/testdata/z7-token-vectors.json) and assert the REASON each
 * negative case is refused for, so a row whose mutation leaves the case
 * refused for a different reason still reds.
 *
 * Each row plants one textual mutation (anchor EXACTLY ONCE in its subject,
 * via `lib/mutation-harness.mjs`, which marks residue and restores
 * byte-identically) and runs `go test` over the row's packages, graded by
 * EXIT CODE only:
 *
 *   P*  parsing (token.go): segment count, the base64url alphabet and
 *       canonical decoding, UTF-8, one JSON value, an object, duplicate
 *       members, the closed header, typ, an empty kid, alg, an unknown kid,
 *       the signature, a missing or non-string claim, an integer claim.
 *   C*  the claims (token.go): lifetime (both bounds), expiry, the skew on
 *       exp and iat, issuer, audience, method, the AUTH_USER subject, and
 *       AUTH_PUBLIC not demanding one.
 *   J*  the JWKS (jwks.go): kty, crv, key length, kid derived from the key,
 *       a removed or unparseable JWKS not served from cache, the reload on
 *       change and on the interval, the bounded read, a set with no keys.
 *   V*  the verifier (verifier.go): issuer and audience configured, an RPC
 *       with no auth option refused, the option read from the contract, the
 *       procedure parse, the default policy.
 *   I*, W*, M*  the caller identity reaching the handler (auth.go), New
 *       wiring the issuer (rpc.go), main reading it from the env (main.go).
 *   N*  negative control: a re-read interval shorter than the contract's
 *       bound is tolerated, so the suite must stay GREEN.
 *
 * A row counts only if the mutated tree COMPILES: before its test run, each
 * row must pass a build-only `go test -run ^$` over the same packages. A row
 * that does not compile is reported NOT-COMPILED and fails the prover.
 *
 * NOT A JS TEST SUITE: the guards are Go tests, so there is no vitest runner
 * to resolve. Path-listed in `NON_JS_TEST_SUITE_PROVERS`
 * (`lib/prover-lane.mjs`); spawns only `go`, run in `templates/go` with
 * GOTOOLCHAIN=auto (the template's go.mod may name a newer Go than PATH's).
 *
 *   node scripts/mutation-prove-2051-go-verifier.mjs
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
// The Go module (the command's cwd), not a mutation subject.
const TEMPLATE_MODULE = `${REPO_ROOT}/templates/go`;
const SUBJECTS = {
  token: resolve(REPO_ROOT, 'templates/go/internal/auth/token.go'),
  jwks: resolve(REPO_ROOT, 'templates/go/internal/auth/jwks.go'),
  verifier: resolve(REPO_ROOT, 'templates/go/internal/auth/verifier.go'),
  auth: resolve(REPO_ROOT, 'templates/go/internal/auth/auth.go'),
  server: resolve(REPO_ROOT, 'templates/go/internal/rpc/rpc.go'),
  main: resolve(REPO_ROOT, 'templates/go/main.go'),
};

const AUTH_PKG = ['./internal/auth/'];
const RPC_PKG = ['./internal/rpc/'];
const MAIN_PKG = ['.'];

// -count=1: never trust a cached pass for a mutated tree.
const goTest = (pkgs) => ['go', 'test', '-count=1', '-timeout', '180s', ...pkgs];
// The same packages, compiled with their tests (and go test's vet subset),
// running no test.
const goBuild = (pkgs) => ['go', 'test', '-count=1', '-run', '^$', ...pkgs];

// Every replacement ends in '\n', so the harness puts its residue marker on a
// line of its own rather than swallowing the line after the anchor.
const MUTATIONS = [
  // ── P: parsing ────────────────────────────────────────────────────────────
  {
    id: 'P1',
    claim: 'a token with fewer than three segments is padded, not refused',
    subject: 'token',
    anchor:
      '\tif len(segments) != 3 {\n\t\treturn claims{}, malformed("%d segments, want 3", len(segments))\n\t}\n',
    replacement: '\tsegments = append(segments, "", "")\n',
  },
  {
    id: 'P2',
    claim: 'bytes outside the base64url alphabet (CR, LF) are skipped, not refused',
    subject: 'token',
    anchor:
      "\t\tif !('A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_') {\n",
    replacement: '\t\tif c == 0 {\n',
  },
  {
    id: 'P3',
    claim: 'non-canonical base64url (non-zero trailing bits) decodes',
    subject: 'token',
    anchor: 'var strictBase64 = base64.RawURLEncoding.Strict()\n',
    replacement: 'var strictBase64 = base64.RawURLEncoding\n',
  },
  {
    id: 'P4',
    claim: 'invalid UTF-8 in the JSON is replaced, not refused',
    subject: 'token',
    anchor: '\tif !utf8.Valid(data) {\n',
    replacement: '\tif len(data) == 0 && !utf8.Valid(data) {\n',
  },
  {
    id: 'P5',
    claim: 'trailing or unterminated JSON is read as far as it parses',
    subject: 'token',
    anchor: '\tif !json.Valid(data) {\n',
    replacement: '\tif len(data) == 0 {\n',
  },
  {
    id: 'P6',
    claim: 'a JSON array of name/value pairs is read as an object',
    subject: 'token',
    anchor: "\tif tok, _ := dec.Token(); tok != json.Delim('{') {\n",
    replacement: '\tif tok, _ := dec.Token(); tok == nil {\n',
  },
  {
    id: 'P7',
    claim: 'a duplicate JSON member keeps the last value (alg, sub)',
    subject: 'token',
    anchor: '\t\tif _, dup := members[name]; dup {\n',
    replacement: '\t\tif _, dup := members[name]; dup && name == "" {\n',
  },
  {
    id: 'P8',
    claim: 'the header admits a crit member',
    subject: 'token',
    anchor: '\t\tif name != "alg" && name != "typ" && name != "kid" {\n',
    replacement: '\t\tif name != "alg" && name != "typ" && name != "kid" && name != "crit" {\n',
  },
  {
    id: 'P9',
    claim: 'any typ is accepted',
    subject: 'token',
    anchor: '\tif typ != "JWT" {\n',
    replacement: '\tif typ == "" {\n',
  },
  {
    id: 'P10',
    claim: 'an empty kid is looked up instead of refused as malformed',
    subject: 'token',
    anchor: '\tif kid == "" {\n\t\treturn claims{}, malformed("empty kid")\n\t}\n',
    replacement: '\n',
  },
  {
    id: 'P11',
    claim: 'an alg other than EdDSA (Ed25519, HS256) is accepted unless it is "none"',
    subject: 'token',
    anchor: '\tif alg, err := stringMember(header, "alg"); err != nil || alg != "EdDSA" {\n',
    replacement: '\tif alg, err := stringMember(header, "alg"); err != nil || alg == "none" {\n',
  },
  {
    id: 'P12',
    claim: 'an unknown kid falls back to any key in the JWKS',
    subject: 'token',
    anchor: '\tkey, ok := keys[kid]\n\tif !ok {\n\t\treturn claims{}, ErrUnknownKID\n\t}\n',
    replacement:
      '\tkey, ok := keys[kid]\n\tif !ok {\n\t\tfor _, k := range keys {\n\t\t\tkey = k\n\t\t}\n\t}\n',
  },
  {
    id: 'P13',
    claim: 'the signature is not verified',
    subject: 'token',
    anchor:
      '\tif len(signature) != ed25519.SignatureSize || !ed25519.Verify(key, []byte(h+"."+p), signature) {\n',
    replacement:
      '\tif len(signature) != ed25519.SignatureSize || len(key) != ed25519.PublicKeySize {\n',
  },
  {
    id: 'P14',
    claim: 'a missing string claim reads as empty (sub on an AUTH_PUBLIC RPC)',
    subject: 'token',
    anchor: '\tif !ok {\n\t\treturn "", malformed("missing %q", name)\n\t}\n',
    replacement: '\tif !ok {\n\t\treturn "", nil\n\t}\n',
  },
  {
    id: 'P15',
    claim: 'a null claim reads as an empty string',
    subject: 'token',
    anchor: "\tif len(raw) == 0 || raw[0] != '\"' || json.Unmarshal(raw, &s) != nil {\n",
    replacement: '\tif json.Unmarshal(raw, &s) != nil {\n',
  },
  {
    id: 'P16',
    claim: 'a fractional exp is truncated to an integer',
    subject: 'token',
    anchor: '\tn, err := strconv.ParseInt(string(raw), 10, 64)\n',
    replacement: '\tf, err := strconv.ParseFloat(string(raw), 64)\n\tn := int64(f)\n',
  },
  // ── C: the claims ─────────────────────────────────────────────────────────
  {
    id: 'C1',
    claim: 'exp - iat above 60 s is accepted',
    subject: 'token',
    anchor: '\tif c.exp <= c.iat || uint64(c.exp)-uint64(c.iat) > maxLifetime {\n',
    replacement: '\tif c.exp <= c.iat || maxLifetime == 0 {\n',
  },
  {
    id: 'C2',
    claim: 'exp at or before iat is accepted',
    subject: 'token',
    anchor: '\tif c.exp <= c.iat || uint64(c.exp)-uint64(c.iat) > maxLifetime {\n',
    replacement: '\tif uint64(c.exp)-uint64(c.iat) > maxLifetime {\n',
  },
  {
    id: 'C3',
    claim: 'an expired token is accepted',
    subject: 'token',
    anchor: '\tif c.exp <= now-skew {\n',
    replacement: '\tif false && c.exp <= now-skew {\n',
  },
  {
    id: 'C4',
    claim: 'a token exactly at exp + skew is accepted (off by one)',
    subject: 'token',
    anchor: '\tif c.exp <= now-skew {\n',
    replacement: '\tif c.exp < now-skew {\n',
  },
  {
    id: 'C5',
    claim: 'the clock skew on exp is dropped (a token 4 s past exp is refused)',
    subject: 'token',
    anchor: '\tif c.exp <= now-skew {\n',
    replacement: '\tif c.exp <= now {\n',
  },
  {
    id: 'C6',
    claim: 'a token issued in the future is accepted',
    subject: 'token',
    anchor: '\tif c.iat > now+skew {\n',
    replacement: '\tif false && c.iat > now+skew {\n',
  },
  {
    id: 'C7',
    claim: 'the clock skew on iat is dropped (a token issued 5 s ahead is refused)',
    subject: 'token',
    anchor: '\tif c.iat > now+skew {\n',
    replacement: '\tif c.iat > now {\n',
  },
  {
    id: 'C8',
    claim: 'the issuer is not checked (wrong zone, misconfigured JWKS)',
    subject: 'token',
    anchor: '\tif c.iss != issuer {\n',
    replacement: '\tif c.iss == "" {\n',
  },
  {
    id: 'C9',
    claim: 'the audience is not checked',
    subject: 'token',
    anchor: '\tif c.aud != audience {\n',
    replacement: '\tif c.aud == "" {\n',
  },
  {
    id: 'C10',
    claim: 'the method is not bound to the RPC called',
    subject: 'token',
    anchor: '\tif c.method != procedure {\n',
    replacement: '\tif c.method == "" {\n',
  },
  {
    id: 'C11',
    claim: 'an AUTH_USER RPC accepts a token with no user',
    subject: 'token',
    anchor: '\tif mode == knextv1.Auth_AUTH_USER && c.sub == "" {\n',
    replacement: '\tif mode == knextv1.Auth_AUTH_USER && c.sub == "" && false {\n',
  },
  {
    id: 'C12',
    claim: 'an AUTH_PUBLIC RPC demands a user too (the option is ignored)',
    subject: 'token',
    anchor: '\tif mode == knextv1.Auth_AUTH_USER && c.sub == "" {\n',
    replacement: '\tif mode != knextv1.Auth_AUTH_UNSPECIFIED && c.sub == "" {\n',
  },
  // ── J: the JWKS ───────────────────────────────────────────────────────────
  {
    id: 'J1',
    claim: 'a JWK of another kty is used',
    subject: 'jwks',
    anchor: '\t\tif jwkString(k, "kty") != "OKP" {\n',
    replacement: '\t\tif jwkString(k, "kty") == "" {\n',
  },
  {
    id: 'J2',
    claim: 'a JWK of another crv is used',
    subject: 'jwks',
    anchor: '\t\tif jwkString(k, "crv") != "Ed25519" {\n',
    replacement: '\t\tif jwkString(k, "crv") == "" {\n',
  },
  {
    id: 'J3',
    claim: 'a JWK whose key is not 32 bytes is used',
    subject: 'jwks',
    anchor: '\t\tif err != nil || len(raw) != ed25519.PublicKeySize {\n',
    replacement: '\t\tif err != nil {\n',
  },
  {
    id: 'J4',
    claim: 'a JWK whose kid is not derived from its key is used',
    subject: 'jwks',
    anchor: '\t\tif kid != keyID(raw) {\n',
    replacement: '\t\tif kid == "" {\n',
  },
  {
    id: 'J5',
    claim: 'a JWKS removed after it was read keeps serving its cached keys',
    subject: 'jwks',
    anchor: '\tif !jwksMounted(info, err) {\n\t\treturn nil, ErrNoJWKS\n\t}\n',
    replacement:
      '\tif !jwksMounted(info, err) {\n\t\tif f.cached != nil {\n\t\t\treturn f.cached, nil\n\t\t}\n\t\treturn nil, ErrNoJWKS\n\t}\n',
  },
  {
    id: 'J6',
    claim: 'a changed JWKS file is not re-read until the interval passes (no warm-pod pickup)',
    subject: 'jwks',
    anchor:
      '\tif f.loaded && info.ModTime().Equal(f.mtime) && info.Size() == f.size && now.Sub(f.readAt) < JWKSRereadInterval {\n',
    replacement: '\tif f.loaded && now.Sub(f.readAt) < JWKSRereadInterval {\n',
  },
  {
    id: 'J7',
    claim: 'the JWKS is never re-read while its mtime and size hold still',
    subject: 'jwks',
    anchor:
      '\tif f.loaded && info.ModTime().Equal(f.mtime) && info.Size() == f.size && now.Sub(f.readAt) < JWKSRereadInterval {\n',
    replacement: '\tif f.loaded && info.ModTime().Equal(f.mtime) && info.Size() == f.size {\n',
  },
  {
    id: 'J8',
    claim: 'an unparseable JWKS keeps the keys of the last good read',
    subject: 'jwks',
    anchor: '\tkeys, err := parseJWKS(data)\n',
    replacement:
      '\tkeys, err := parseJWKS(data)\n\tif err != nil && f.cached != nil {\n\t\tkeys, err = f.cached, nil\n\t}\n',
  },
  {
    id: 'J9',
    claim: 'the JWKS read is unbounded',
    subject: 'jwks',
    anchor: '\tdata, err := io.ReadAll(io.LimitReader(file, limit+1))\n',
    replacement: '\tdata, err := io.ReadAll(file)\n\tlimit = int64(len(data))\n',
  },
  {
    id: 'J10',
    claim: 'a JSON object with no keys array reads as an empty JWK Set',
    subject: 'jwks',
    anchor: '\tif err := json.Unmarshal(data, &set); err != nil || set.Keys == nil {\n',
    replacement: '\tif err := json.Unmarshal(data, &set); err != nil {\n',
  },
  // ── V: the verifier ───────────────────────────────────────────────────────
  {
    id: 'V1',
    claim: 'a verifier with only one of issuer and audience set runs',
    subject: 'verifier',
    anchor: '\tif v.cfg.Issuer == "" || v.cfg.Audience == "" {\n',
    replacement: '\tif v.cfg.Issuer == "" && v.cfg.Audience == "" {\n',
  },
  {
    id: 'V2',
    claim: 'an RPC that states no auth option is served',
    subject: 'verifier',
    anchor: '\tif mode != knextv1.Auth_AUTH_USER && mode != knextv1.Auth_AUTH_PUBLIC {\n',
    replacement: '\tif mode == -1 {\n',
  },
  {
    id: 'V3',
    claim: 'the contract lookup reads every RPC as AUTH_PUBLIC',
    subject: 'verifier',
    anchor:
      '\t\tmode, _ := proto.GetExtension(opts, knextv1.E_Auth).(knextv1.Auth)\n\t\treturn mode\n',
    replacement:
      '\t\tmode, _ := proto.GetExtension(opts, knextv1.E_Auth).(knextv1.Auth)\n\t\t_ = mode\n\t\treturn knextv1.Auth_AUTH_PUBLIC\n',
  },
  {
    id: 'V4',
    claim: 'a procedure without its leading slash resolves',
    subject: 'verifier',
    anchor: '\trest, ok := strings.CutPrefix(procedure, "/")\n\tif !ok {\n',
    replacement: '\trest, ok := strings.CutPrefix(procedure, "/")\n\tif !ok && rest == "" {\n',
  },
  {
    id: 'V5',
    claim: "the binary's default policy reads every RPC as AUTH_PUBLIC",
    subject: 'verifier',
    pkgs: [...AUTH_PKG, ...RPC_PKG],
    anchor: '\t\tcfg.MethodAuth = DescriptorAuth(protoregistry.GlobalFiles)\n',
    replacement:
      '\t\tcfg.MethodAuth = func(string) knextv1.Auth { _ = protoregistry.GlobalFiles; return knextv1.Auth_AUTH_PUBLIC }\n',
  },
  // ── I, W, M: identity, wiring, env ────────────────────────────────────────
  {
    id: 'I1',
    claim: "the verified caller never reaches the handler's context",
    subject: 'auth',
    anchor: '\t\t\treturn next(withCaller(ctx, caller), spec, stream)\n',
    replacement: '\t\t\t_ = caller\n\t\t\treturn next(ctx, spec, stream)\n',
  },
  {
    id: 'W1',
    claim: 'New holds tokens to the audience as their issuer',
    subject: 'server',
    pkgs: RPC_PKG,
    anchor: '\t\tIssuer:   cfg.Issuer,\n',
    replacement: '\t\tIssuer:   cfg.Audience,\n',
  },
  {
    id: 'M1',
    claim: "main reads the issuer from the audience's variable",
    subject: 'main',
    pkgs: MAIN_PKG,
    anchor: '\t\tIssuer:   getenv(auth.EnvIssuer),\n',
    replacement: '\t\tIssuer:   getenv(auth.EnvAudience),\n',
  },
  // ── N: negative control ───────────────────────────────────────────────────
  {
    id: 'N1',
    expect: 'green',
    claim: 'a 5 s re-read interval (inside the contract bound) is tolerated',
    subject: 'verifier',
    anchor: '\tJWKSRereadInterval = 10 * time.Second\n',
    replacement: '\tJWKSRereadInterval = 5 * time.Second\n',
  },
].map((m) => ({ expect: 'red', pkgs: AUTH_PKG, ...m }));

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
      `mutation-prove-2051-go-verifier: cannot run ${bin}: ${r.error?.message ?? r.signal}`,
    );
    return null;
  }
  return r.status;
}

declareMutations(MUTATIONS.length);
console.log(`mutation-prove-2051-go-verifier: ${MUTATIONS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of MUTATIONS) {
  const path = SUBJECTS[m.subject];
  if (path === undefined) {
    console.error(`mutation-prove-2051-go-verifier: ${m.id} names no subject ${m.subject}`);
    process.exit(2);
  }
  const count = snapshot(path).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `mutation-prove-2051-go-verifier: ${m.id}'s anchor occurs ${count} times in ${path}; aborting`,
    );
    process.exit(2);
  }
}

// Green baseline on a clean tree over every package a row runs, else every
// verdict below is noise.
const ALL_PKGS = [...AUTH_PKG, ...RPC_PKG, ...MAIN_PKG];
assertTreeClean(REPO_ROOT, 'baseline');
const baseBuild = goExit(goBuild(ALL_PKGS));
if (baseBuild === null) process.exit(2);
if (baseBuild !== 0) {
  console.error(
    `mutation-prove-2051-go-verifier: baseline does not compile (exit ${baseBuild}); fix the tree first`,
  );
  process.exit(2);
}
const base = goExit(goTest(ALL_PKGS));
if (base === null) process.exit(2);
if (base !== 0) {
  console.error(`mutation-prove-2051-go-verifier: baseline RED (exit ${base}); fix the tree first`);
  process.exit(2);
}
console.log('mutation-prove-2051-go-verifier: baseline green');

let failed = 0;
for (const m of MUTATIONS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(SUBJECTS[m.subject]);
  let build;
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    // A mutation that does not compile is red for the wrong reason.
    build = goExit(goBuild(m.pkgs));
    if (build === 0) code = goExit(goTest(m.pkgs));
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
  `mutation-prove-2051-go-verifier: ${MUTATIONS.length - failed}/${MUTATIONS.length} behaved as required`,
);
process.exit(failed === 0 ? 0 : 1);
