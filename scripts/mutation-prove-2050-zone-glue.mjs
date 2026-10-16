#!/usr/bin/env node
/**
 * Mutation proof for the generated zone glue of @getknext/grpc (#2050): every
 * refusal, the two-user `'use cache'` isolation, the Node/Bun transport choice,
 * the missing-status rule and the runtime's fail-closed checks.
 *
 * Six guards, six specs, one table each:
 *
 *   - `glue-refusals.test.ts` — every case `knext generate` refuses: no auth
 *     option, AUTH_UNSPECIFIED, AUTH_PUBLIC on a write, AUTH_PUBLIC_MUTATION (by
 *     the shipped options contract AND by value), client/bidi streaming, an
 *     action for a stream, export-name collisions, no authorize() hook or a
 *     missing one.
 *   - `use-cache-two-user.test.ts` — a real Next.js build, pods sharing one
 *     Redis: keying on the token, dropping the user from the key, dropping the
 *     served version from it, losing either tag call, and a write that fails
 *     after it was sent no longer refreshing the reads must each go red.
 *   - `gateway-transport.test.ts` — Node and Bun gateway processes: the Bun
 *     HTTP/1.1 fallback, the transport log line and the per-binding override.
 *   - `missing-trailer.test.ts` — a response with no status is not retried.
 *   - `glue-runtime.test.ts` — the end-user check, the served version and the
 *     token seam fail closed; a request carries only the contract's fields (a
 *     forged `$typeName`/`$unknown` or a non-object request never reaches the
 *     wire or a cache key).
 *   - `glue-action-refresh.test.ts` — a generated Server Action refreshes the
 *     cached reads whenever the write may have reached the function (it failed
 *     after the request was sent), and never when it was refused before.
 *
 * Each mutation removes ONE behaviour and requires its spec to go red. Verdicts
 * are by EXIT CODE only (the shared driver, `scripts/lib/guard-prover.mjs`),
 * every anchor must occur exactly once (preflight first), each baseline must be
 * green, a canary must go red before any green is trusted, and every restore is
 * content-verified. The two-user spec needs @getknext/core's dist built.
 *
 * Usage:  node scripts/mutation-prove-2050-zone-glue.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROTO = { commentPrefix: '//' };

// ── refusals ──────────────────────────────────────────────────────────────
const REFUSALS = [
  {
    id: 'R01',
    subject: 'plugin',
    claim: 'an RPC that does not state (knext.v1.auth) is generated anyway',
    anchor: '  if (!hasOption(method, ext)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'R02',
    subject: 'plugin',
    claim:
      'an auth value other than AUTH_USER/AUTH_PUBLIC (AUTH_UNSPECIFIED, a defined AUTH_PUBLIC_MUTATION) is treated as AUTH_USER',
    anchor:
      '  return `${rpcName(method)} states (knext.v1.auth) = ${name}: the only values are AUTH_USER or AUTH_PUBLIC`;',
    replacement: "  return 'user';",
  },
  {
    id: 'R03',
    subject: 'plugin',
    claim: 'AUTH_PUBLIC is accepted on a write (no end-user check on a mutating action)',
    anchor: '    if (method.idempotency !== MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS) {',
    replacement: '    if (false) {',
  },
  {
    id: 'R04',
    subject: 'options',
    claim: 'the shipped options contract no longer reserves AUTH_PUBLIC_MUTATION',
    anchor: '  reserved 3;\n  reserved "AUTH_PUBLIC_MUTATION";',
    replacement: '  reserved 4;',
    options: PROTO,
  },
  {
    id: 'R05',
    subject: 'options',
    claim: 'the shipped options contract offers AUTH_PUBLIC_MUTATION',
    anchor: '  reserved 3;\n  reserved "AUTH_PUBLIC_MUTATION";',
    replacement: '  AUTH_PUBLIC_MUTATION = 3;',
    options: PROTO,
  },
  {
    id: 'R06',
    subject: 'plugin',
    claim: 'a client-streaming or bidi RPC is planned as a stream instead of refused',
    anchor: '    default:\n      return (',
    replacement: "    default:\n      if (method.methodKind) return 'stream';\n      return (",
  },
  {
    id: 'R07',
    subject: 'plugin',
    claim: 'the action emitter no longer refuses a streaming RPC',
    anchor: "  if (method.methodKind !== 'unary') {",
    replacement: '  if (false) {',
  },
  {
    id: 'R08',
    subject: 'plugin',
    claim: 'two RPCs exporting the same name are no longer refused',
    anchor: '        if (clash) {',
    replacement: '        if (false) {',
  },
  {
    id: 'R09',
    subject: 'plugin',
    claim: 'generation without an authorize() hook is no longer refused up front',
    anchor:
      '  if (problems.length === 0 && planned.size > 0 && schema.options.authorize === undefined) {',
    replacement: '  if (false) {',
  },
  {
    id: 'R10',
    subject: 'generate',
    claim: 'an authorize setting naming a file that does not exist is accepted',
    anchor: '    if (!existsSync(join(cwd, config.authorize))) {',
    replacement: '    if (false) {',
  },
  {
    id: 'R11',
    subject: 'plugin',
    claim: 'an options contract with no auth option is not refused with the fix named',
    anchor: '    if (!ext) {',
    replacement: '    if (!ext && false) {',
  },
];

// ── the two-user 'use cache' test ─────────────────────────────────────────
const KEY_BLOCK =
  '    `  return ${name}$cached(subject, ${servedVersionExpr(ctx)}, ${encode}(${input}, request));`,\n' +
  "    '}',\n" +
  "    '',\n" +
  '    `async function ${name}$cached(subject: string, protoVersion: string, request: string): Promise<${output}> {`,\n' +
  '    \'  "use cache";\',\n' +
  '    `  ${cacheLife}(${life});`,\n' +
  '    `  ${cacheTag}(${JSON.stringify(serviceTag(ctx.fn, method))});`,\n' +
  "    '  // protoVersion is part of the cache key only: a function rollout is a new entry.',\n" +
  "    '  void protoVersion;',\n" +
  "    `  const token = ${mintExpr(ctx, method, 'subject')};`,";

// The one line of the emitted action that refreshes the reads, and the one
// that decides whether a failed call may have committed.
const REFRESH_LINE =
  '    `    if (mayHaveCommitted) ${updateTag}(${JSON.stringify(serviceTag(ctx.fn, method))});`,';
const SENT_LINE = '    `    mayHaveCommitted = !${wasNotSent}(err);`,';

const TWO_USER = [
  {
    id: 'U01',
    subject: 'plugin',
    claim:
      'the user is dropped from the cache key (it reaches the token through a side channel): B is served A',
    anchor: KEY_BLOCK,
    replacement: KEY_BLOCK.replace(
      '    `  return ${name}$cached(subject,',
      '    `  globalThis.__knextSubject = subject;`,\n    `  return ${name}$cached("everyone",',
    ).replace(
      "${mintExpr(ctx, method, 'subject')}",
      "${mintExpr(ctx, method, 'globalThis.__knextSubject')}",
    ),
  },
  {
    id: 'U02',
    subject: 'plugin',
    claim:
      'the cache keys on the token (minted outside the cached function): no read is ever a hit',
    anchor: KEY_BLOCK,
    // The token is minted BEFORE the cached call and becomes its first key
    // argument; the cached function's own mint is gone.
    replacement:
      "    `  const token = ${mintExpr(ctx, method, 'subject')};`,\n" +
      '    `  return ${name}$cached(token, ${servedVersionExpr(ctx)}, ${encode}(${input}, request));`,\n' +
      "    '}',\n" +
      "    '',\n" +
      '    `async function ${name}$cached(token: string, protoVersion: string, request: string): Promise<${output}> {`,\n' +
      '    \'  "use cache";\',\n' +
      '    `  ${cacheLife}(${life});`,\n' +
      '    `  ${cacheTag}(${JSON.stringify(serviceTag(ctx.fn, method))});`,\n' +
      "    '  void protoVersion;',",
  },
  {
    id: 'U03',
    subject: 'plugin',
    claim: 'the served contract version is not in the key: a newer function reuses the old entry',
    anchor:
      '    `  return ${name}$cached(subject, ${servedVersionExpr(ctx)}, ${encode}(${input}, request));`,',
    replacement:
      '    `  ${servedVersionExpr(ctx)};`,\n    `  return ${name}$cached(subject, "any-version", ${encode}(${input}, request));`,',
  },
  {
    id: 'U04',
    subject: 'plugin',
    claim: 'a write no longer calls updateTag: cached reads on other pods stay stale',
    anchor: REFRESH_LINE,
    replacement: '    `    void mayHaveCommitted, ${updateTag};`,',
  },
  {
    id: 'U05',
    subject: 'plugin',
    claim: "reads are no longer tagged: a write's updateTag refreshes nothing",
    anchor: '    `  ${cacheTag}(${JSON.stringify(serviceTag(ctx.fn, method))});`,',
    replacement: '    `  void ${cacheTag};`,',
  },
  {
    id: 'U06',
    subject: 'plugin',
    claim:
      'a write that fails after it was sent refreshes nothing: pods keep pre-write reads although it may have committed',
    anchor: SENT_LINE,
    replacement: "    '    mayHaveCommitted = false;',",
  },
];

// ── a failed write refreshes the reads only if it may have been sent ──────
const CHECKS_THEN_CALL =
  '    `  const message = ${normalize}(${input}, request);`,\n' +
  "    `  const token = ${mintExpr(ctx, method, 'subject')};`,\n" +
  "    '  let mayHaveCommitted = true;',\n" +
  "    '  try {',\n" +
  '    `    return await ${client}.${name}(message, { idempotencyKey: options?.idempotencyKey, token });`,';

const ACTION = [
  {
    id: 'A01',
    subject: 'plugin',
    claim: 'only a successful write refreshes the reads (the round-1 behaviour)',
    anchor: SENT_LINE,
    replacement: "    '    mayHaveCommitted = false;',",
  },
  {
    id: 'A02',
    subject: 'plugin',
    claim: 'every failed write refreshes the reads, one the client refused before sending included',
    anchor: REFRESH_LINE,
    replacement:
      '    `    if (true) ${updateTag}(${JSON.stringify(serviceTag(ctx.fn, method))});`,',
  },
  {
    id: 'A03',
    subject: 'runtime',
    claim: 'the client no longer marks the failures it raises before sending',
    anchor: '        throw markNotSent(err);',
    replacement: '        throw err;',
  },
  {
    id: 'A04',
    subject: 'glue',
    claim: 'the not-sent mark is never read',
    anchor:
      "    typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[NOT_SENT] === true",
    replacement: '    false',
  },
  {
    id: 'A05',
    subject: 'plugin',
    claim: 'the request is validated inside the try, where a refusal counts as a sent write',
    anchor: CHECKS_THEN_CALL,
    replacement: CHECKS_THEN_CALL.replace(
      '    `  const message = ${normalize}(${input}, request);`,',
      "    '  const message = request;',",
    ).replace('(message, {', '(${normalize}(${input}, message), {'),
  },
];

// ── Node and Bun gateways ─────────────────────────────────────────────────
const TRANSPORT = [
  {
    id: 'T01',
    subject: 'runtime',
    claim: 'a Bun gateway no longer falls back to HTTP/1.1 (h2c on the unverified client)',
    anchor: '  if (isBun) {',
    replacement: '  if (false) {',
  },
  {
    id: 'T02',
    subject: 'runtime',
    claim: 'the chosen transport is no longer logged',
    anchor: '      log(choice.notice);',
    replacement: '      void choice.notice;',
  },
  {
    id: 'T03',
    subject: 'runtime',
    claim: '<NAME>_SERVICE_HTTP_VERSION=1.1 no longer overrides the gateway default',
    anchor: "  if (explicit === '1.1') {",
    replacement: '  if (false) {',
  },
];

// ── a missing status ──────────────────────────────────────────────────────
const TRAILER = [
  {
    id: 'M01',
    subject: 'runtime',
    claim: 'a read is retried on any error, a missing status included',
    anchor:
      '          if (attempt >= attempts || e.code !== Code.Unavailable || options?.signal?.aborted)',
    replacement: '          if (attempt >= attempts || options?.signal?.aborted)',
  },
];

// ── runtime fail-closed checks ────────────────────────────────────────────
const RUNTIME = [
  {
    id: 'G01',
    subject: 'glue',
    claim: 'with no minter registered, a call is not refused as FAILED_PRECONDITION',
    anchor: "  if (typeof minter !== 'function') {",
    replacement: '  if (false) {',
  },
  {
    id: 'G02',
    subject: 'glue',
    claim: 'authorize() returning no usable sub is accepted',
    anchor: "  if (typeof sub !== 'string' || !SUB.test(sub)) {",
    replacement: '  if (false) {',
  },
  {
    id: 'G03',
    subject: 'glue',
    claim: 'a function older than its zone is called anyway',
    anchor: '  if (skew.skew) {',
    replacement: '  if (false) {',
  },
  {
    id: 'G04',
    subject: 'glue',
    claim: 'an unset served version is not refused by name',
    anchor: "  if (served === undefined || served === '') {",
    replacement: '  if (false) {',
  },
  {
    id: 'G05',
    subject: 'glue',
    claim: 'decoding keeps fields the contract does not have (they are re-encoded and forwarded)',
    anchor: 'const CONTRACT_FIELDS_ONLY = { readUnknownFields: false } as const;',
    replacement: 'const CONTRACT_FIELDS_ONLY = { readUnknownFields: true } as const;',
  },
  {
    id: 'G06',
    subject: 'glue',
    claim:
      "a caller-supplied $typeName and $unknown are trusted (create() keeps the caller's object)",
    anchor:
      '  const { $typeName: _typeName, $unknown: _unknown, ...fields } = input as Record<string, unknown>;',
    replacement: '  const fields = input as Record<string, unknown>;',
  },
  {
    id: 'G07',
    subject: 'glue',
    claim: 'a plain array (or another non-object) is accepted as an empty request',
    anchor: "  if (input === null || typeof input !== 'object' || Array.isArray(input)) {",
    replacement: '  if (false) {',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const refusals = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/glue-refusals.test.ts',
  subjects: {
    plugin: 'packages/grpc/src/glue-plugin.ts',
    options: 'packages/grpc/proto/knext/v1/options.proto',
    generate: 'packages/grpc/src/generate.ts',
  },
});
const twoUser = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/use-cache-two-user.test.ts',
  subjects: { plugin: 'packages/grpc/src/glue-plugin.ts' },
});
const transport = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/gateway-transport.test.ts',
  subjects: { runtime: 'packages/grpc/src/runtime.ts' },
});
const trailer = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/missing-trailer.test.ts',
  subjects: { runtime: 'packages/grpc/src/runtime.ts' },
});
const runtime = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/glue-runtime.test.ts',
  subjects: { glue: 'packages/grpc/src/glue.ts' },
});
const action = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/glue-action-refresh.test.ts',
  subjects: {
    plugin: 'packages/grpc/src/glue-plugin.ts',
    glue: 'packages/grpc/src/glue.ts',
    runtime: 'packages/grpc/src/runtime.ts',
  },
});

console.log('=== mutation proof: @getknext/grpc zone glue (#2050) ===');
refusals.preflight(REFUSALS);
twoUser.preflight(TWO_USER);
transport.preflight(TRANSPORT);
trailer.preflight(TRAILER);
runtime.preflight(RUNTIME);
action.preflight(ACTION);
declareMutations(
  REFUSALS.length +
    TWO_USER.length +
    TRANSPORT.length +
    TRAILER.length +
    RUNTIME.length +
    ACTION.length,
);

console.log('\n=== refusals (knext generate) ===');
refusals.baseline();
refusals.proveCanSeeRed({
  subject: 'plugin',
  anchor: "  if (problems.length > 0) throw new Error(problems.join('\\n'));",
  replacement: '  void problems;',
});
for (const m of REFUSALS) {
  refusals.run({ ...m, expect: 'red' });
  recordMutation();
}
refusals.finish(REFUSALS.length);

console.log("\n=== two users, one 'use cache' backend (real Next.js, pods, Redis) ===");
twoUser.baseline();
twoUser.proveCanSeeRed({
  subject: 'plugin',
  anchor: '    \'  "use cache";\',',
  replacement: '    \'  "use nothing";\',',
});
for (const m of TWO_USER) {
  twoUser.run({ ...m, expect: 'red' });
  recordMutation();
}
twoUser.finish(TWO_USER.length);

console.log('\n=== Node and Bun gateways ===');
transport.baseline();
transport.proveCanSeeRed({
  subject: 'runtime',
  anchor: '      headers.set(AUTHORIZATION_HEADER, `Bearer ${options.token}`);',
  replacement: '      void options.token;',
});
for (const m of TRANSPORT) {
  transport.run({ ...m, expect: 'red' });
  recordMutation();
}
transport.finish(TRANSPORT.length);

console.log('\n=== a missing status is not retried ===');
trailer.baseline();
trailer.proveCanSeeRed({
  subject: 'runtime',
  anchor: '  checkDefinition(def);',
  replacement: "  throw new Error('canary: no client can be defined');",
});
for (const m of TRAILER) {
  trailer.run({ ...m, expect: 'red' });
  recordMutation();
}
trailer.finish(TRAILER.length);

console.log('\n=== runtime fail-closed checks ===');
runtime.baseline();
runtime.proveCanSeeRed({
  subject: 'glue',
  anchor: "const USER_PREFIX = 'user:';",
  replacement: "const USER_PREFIX = '';",
});
for (const m of RUNTIME) {
  runtime.run({ ...m, expect: 'red' });
  recordMutation();
}
runtime.finish(RUNTIME.length);

console.log('\n=== a failed write refreshes the reads only if it may have been sent ===');
action.baseline();
action.proveCanSeeRed({
  subject: 'plugin',
  anchor:
    '    `    return await ${client}.${name}(message, { idempotencyKey: options?.idempotencyKey, token });`,',
  replacement: "    `    throw new Error('canary: no write is ever made');`,",
});
for (const m of ACTION) {
  action.run({ ...m, expect: 'red' });
  recordMutation();
}
action.finish(ACTION.length);
