#!/usr/bin/env node
/**
 * Mutation proof for the Redis command scan behind the per-app ACL check
 * (issue #2404): `tests/redis-command-scan.ts`, the discovery and allowlist
 * logic in `tests/redis-acl-spike.test.ts`, and the spike's exit-code mapping
 * in `scripts/redis-acl-spike.mjs`.
 *
 * Every row removes ONE rule and REQUIRES `tests/redis-acl-spike.test.ts` to go
 * red. The S rows are the seven escapes the round-2 code review proved green by
 * exit code against the earlier scan (`client.unlink?.(…)`, destructuring,
 * `Reflect.apply`, `.bind`, `unlinkBuffer`, `callBuffer`, `zscanStream`); the U
 * rows are the constructs the scan must report as UNPARSEABLE rather than pass;
 * the X rows widen one of the two exclusions (language-global receivers, calls
 * that pass no Redis argument) past what it is allowed to drop; the D rows are
 * discovery; B1 is the receiver-binding check; E1/E2 are the spike's
 * "an ACL refusal is a finding (1), not a crash (3)" mapping. The R4 rows are
 * the round-4 review: ioredis's real method grammar (`zscanBufferStream`, a
 * zero-argument `*Stream` that still sends SCAN, `send_command`, the builtin-
 * command helpers, the client-only commands such as HGETDEL, the prototype walk
 * that keeps all of it honest), the node:crypto `.digest` exclusion both ways,
 * and NOT_REDIS_RECEIVERS per command and per binding (destructuring, import,
 * re-assignment). The R4-I rows and R4-N2/R4-B2 INJECT the escaping construct
 * into a scanned runtime file rather than remove a rule.
 *
 * The L rows need a Redis: they run only when KNEXT_REDIS_LIVE_URL is set (the
 * same loopback URL the live lane uses), and are not declared otherwise. They
 * prove the full-mode `--drop=set` exit 1 and the two matrix rows that make
 * `--drop=hdel` / `--drop=discard` visible. Every other row runs with
 * KNEXT_REDIS_LIVE_URL removed from the environment, so it measures the
 * always-on half the CI lane depends on.
 *
 * The shared driver (`scripts/lib/guard-prover.mjs`) owns the discipline:
 * verdicts by EXIT CODE only (output is never parsed), baseline green first, a
 * canary that must go red, anchors that must occur exactly once, a byte-exact
 * restore and a clean tree between rows.
 *
 * Usage:
 *   node scripts/mutation-prove-redis-command-scan.mjs
 *   KNEXT_REDIS_LIVE_URL=redis://127.0.0.1:6409 node scripts/mutation-prove-redis-command-scan.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/redis-acl-spike.test.ts';
const LIVE_URL = process.env.KNEXT_REDIS_LIVE_URL ?? '';

const MUTATIONS = [
  // ── S: the seven round-2 escapes ────────────────────────────────────────────
  {
    id: 'S1',
    expect: 'red',
    claim: "an optional call is not a call: client.unlink?.('k') is missed",
    subject: 'scan',
    anchor: '  if (/^\\s*(?:\\?\\.\\s*)?\\(/.test(rest)) return true; // call, optional call',
    replacement: '  if (/^\\s*\\(/.test(rest)) return true; // call, optional call',
  },
  {
    id: 'S2',
    expect: 'red',
    claim: 'destructuring is not issuance: const { unlink } = client is missed',
    subject: 'scan',
    anchor:
      "      if (cmd !== null) {\n        hits.push({\n          command: cmd,\n          via: 'destructure',",
    replacement:
      "      if (cmd !== null && false) {\n        hits.push({\n          command: cmd,\n          via: 'destructure',",
  },
  {
    id: 'S3',
    expect: 'red',
    claim: 'Reflect.apply(client.unlink, …) is missed',
    subject: 'scan',
    anchor:
      '  if (/Reflect\\s*\\.\\s*apply\\s*\\(\\s*$/.test(before)) return true; // Reflect.apply(<this>, …)',
    replacement: '  if (false) return true; // Reflect.apply(<this>, …)',
  },
  {
    id: 'S4',
    expect: 'red',
    claim: 'client.unlink.bind(client) / .call / .apply are missed',
    subject: 'scan',
    anchor:
      '  if (/^\\s*\\??\\.\\s*(?:bind|call|apply)\\s*\\(/.test(rest)) return true; // bound / forwarded',
    replacement: '  if (false) return true; // bound / forwarded',
  },
  {
    id: 'S4b',
    expect: 'red',
    claim: 'const del = client.unlink; is missed',
    subject: 'scan',
    anchor: '  return /(?:^|[^=!<>])=\\s*$/.test(before) && /^\\s*(?:;|,|\\n|\\)|$)/.test(rest);',
    replacement: '  return false;',
  },
  {
    id: 'S5',
    expect: 'red',
    claim: "ioredis's <cmd>Buffer variant is not a command: client.unlinkBuffer('k') is missed",
    subject: 'scan',
    anchor: "export const IOREDIS_SUFFIXES: readonly string[] = ['buffer', 'stream'];",
    replacement: "export const IOREDIS_SUFFIXES: readonly string[] = ['stream'];",
  },
  {
    id: 'S6',
    expect: 'red',
    claim: "callBuffer is not a generic issuer: client.callBuffer('UNLINK', …) is missed",
    subject: 'scan',
    anchor: "  'send_command',\n  'callbuffer',\n]);",
    replacement: "  'send_command',\n]);",
  },
  {
    id: 'S7',
    expect: 'red',
    claim: "ioredis's <cmd>Stream variant is not a command: client.zscanStream('k') is missed",
    subject: 'scan',
    anchor: "export const IOREDIS_SUFFIXES: readonly string[] = ['buffer', 'stream'];",
    replacement: "export const IOREDIS_SUFFIXES: readonly string[] = ['buffer'];",
  },
  {
    // The first run of this prover had a separate `new Command(` rule here; it
    // SURVIVED its own removal, because this helper rule already resolves
    // `new Redis.Command('UNLINK', …)`. The redundant rule was deleted, and
    // the row now removes the rule that actually carries it.
    id: 'S8',
    expect: 'red',
    claim:
      "the command helper is gone: new Redis.Command('UNLINK', …) and command(c, 'X') are missed",
    subject: 'scan',
    anchor: "  'command',\n  'rediscommand',\n  'createbuiltincommand',",
    replacement: "  'rediscommand',\n  'createbuiltincommand',",
  },
  // ── R4: the round-4 escapes (ioredis's real method grammar and API) ─────────
  // The I rows inject the construct the round-4 review proved green into a
  // scanned runtime file; the others remove the one rule that catches it.
  {
    id: 'R4-I1',
    expect: 'red',
    claim: 'client.zscanBufferStream(key) in cache-handler.js goes unseen (two suffixes)',
    subject: 'cacheHandler',
    anchor: '  const keys = await redisCall(() => client.smembers(tKey));',
    replacement:
      '  const keys = await redisCall(() => client.smembers(tKey));\n  client.zscanBufferStream(tKey);',
  },
  {
    id: 'R4-I2',
    expect: 'red',
    claim: 'client.sscanBufferStream(key, { match }) in cache-handler.js goes unseen',
    subject: 'cacheHandler',
    anchor: '  const keys = await redisCall(() => client.smembers(tKey));',
    replacement:
      "  const keys = await redisCall(() => client.smembers(tKey));\n  client.sscanBufferStream(tKey, { match: 'x:*' });",
  },
  {
    id: 'R4-I3',
    expect: 'red',
    claim: 'a zero-argument client.zscanStream() in cache-handler.js is dropped as arity-safe',
    subject: 'cacheHandler',
    anchor: '  const keys = await redisCall(() => client.smembers(tKey));',
    replacement:
      '  const keys = await redisCall(() => client.smembers(tKey));\n  client.zscanStream();',
  },
  {
    id: 'R4-I4',
    expect: 'red',
    claim: 'a client-only command (client.hgetdel) in cache-handler.js goes unseen',
    subject: 'cacheHandler',
    anchor: '  const keys = await redisCall(() => client.smembers(tKey));',
    replacement:
      "  const keys = await redisCall(() => client.smembers(tKey));\n  client.hgetdel(tKey, 'FIELDS', '1', 'f');",
  },
  {
    id: 'R4-I5',
    expect: 'red',
    claim: "ioredis's send_command issuer in cache-handler.js goes unseen",
    subject: 'cacheHandler',
    anchor: '  const keys = await redisCall(() => client.smembers(tKey));',
    replacement:
      "  const keys = await redisCall(() => client.smembers(tKey));\n  client.send_command('UNLINK', tKey);",
  },
  {
    id: 'R4-S9',
    expect: 'red',
    claim: 'the suffix is stripped once only (the round-3 grammar): zscanBufferStream is missed',
    subject: 'scan',
    anchor: '    if (suffix === undefined) return null;\n    stem = stem.slice(0, -suffix.length);',
    replacement:
      '    if (suffix === undefined) return null;\n    const once = stem.slice(0, -suffix.length);\n    return REDIS_COMMAND_SET.has(once) ? once : null;',
  },
  {
    id: 'R4-Z1',
    expect: 'red',
    claim:
      'a *Stream method with no JS argument is dropped as arity-safe: client.scanStream() is missed',
    subject: 'scan',
    anchor:
      '  if (/stream$/i.test(name)) return false; // ioredis streams: JS arity is not Redis arity',
    replacement: '  void name;',
  },
  {
    id: 'R4-Z2',
    expect: 'red',
    claim: 'the no-argument exclusion also drops client-only commands (client.hotkeys())',
    subject: 'scan',
    anchor: '  return MEASURED.has(cmd) && !NO_ARG.has(cmd);',
    replacement: '  return !NO_ARG.has(cmd);',
  },
  {
    id: 'R4-C1',
    expect: 'red',
    claim: 'the client-only commands are not commands: client.hgetdel(k) is missed',
    subject: 'scan',
    anchor: '  ...REDIS_COMMANDS,\n  ...CLIENT_COMMANDS,\n]);',
    replacement: '  ...REDIS_COMMANDS,\n]);',
  },
  {
    id: 'R4-C2',
    expect: 'red',
    claim: "Sentinel's command (ioredis defines sentinel()) is not a command",
    subject: 'commands',
    anchor: "  'sdiffcard',\n  'sentinel',\n  'sunioncard',",
    replacement: "  'sdiffcard',\n  'sunioncard',",
  },
  {
    id: 'R4-H1',
    expect: 'red',
    claim: "ioredis's createBuiltinCommand / addBuiltinCommand / createScanStream are not helpers",
    subject: 'scan',
    anchor: "  'createbuiltincommand',\n  'addbuiltincommand',\n  'createscanstream',\n]);",
    replacement: ']);',
  },
  {
    id: 'R4-M1',
    expect: 'red',
    claim:
      'defineCommand (a method that sends EVALSHA) is neither a command nor a listed non-command',
    subject: 'scan',
    anchor:
      "  ['definecommand', 'evalsha'], // defines a script method that sends EVALSHA (then EVAL)\n",
    replacement: '',
  },
  {
    id: 'R4-M2',
    expect: 'red',
    claim:
      'Cluster#refreshSlotsCache (sends CLUSTER SLOTS) is unmapped; the prototype walk must catch it',
    subject: 'scan',
    anchor:
      "  ['refreshslotscache', 'cluster'], // Cluster#refreshSlotsCache: CLUSTER SLOTS via getInfoFromNode\n",
    replacement: '',
  },
  {
    id: 'R4-M3',
    expect: 'red',
    claim: 'a client method nobody classified passes (the non-command list is not checked)',
    subject: 'spec',
    anchor:
      "  pipeline: 'builds a pipeline; its commands are scanned as method calls or `[CMD, …]` tuples',\n",
    replacement: '',
  },
  {
    id: 'R4-K1',
    expect: 'red',
    claim: 'the crypto exclusion drops every .digest, so client.digest(k) passes',
    subject: 'scan',
    anchor:
      "  return CRYPTO_DIGEST_CHAIN.test(src.slice(src.lastIndexOf('\\n', start - 1) + 1, start));",
    replacement: '  return true;',
  },
  {
    id: 'R4-K2',
    expect: 'red',
    claim: 'the crypto exclusion is gone: createHash(…).update(…).digest(…) is a false NOPERM hit',
    subject: 'scan',
    anchor:
      '    if (isCryptoDigest(src, lower, start)) continue; // createHash(…).update(…).digest(…)\n',
    replacement: '',
  },
  // ── R4-N: NOT_REDIS_RECEIVERS per command and per binding (non-blocking 4) ──
  {
    id: 'R4-N1',
    expect: 'red',
    claim: 'a receiver entry exempts every command: log.zrange(…) on node-server.ts passes',
    subject: 'spec',
    anchor:
      "  if (h.via === 'method' && receiver?.commands.includes(h.command) === true) return true;",
    replacement: "  if (h.via === 'method' && receiver !== undefined) return true;",
  },
  {
    id: 'R4-N2',
    expect: 'red',
    claim: 'log.zrange(…) injected on the exempt receiver in node-server.ts goes unseen',
    subject: 'nodeServer',
    anchor: 'const log = createLogger({ module: "server" });',
    replacement: 'const log = createLogger({ module: "server" });\nvoid log.zrange("k", 0, -1);',
  },
  {
    id: 'R4-B2',
    expect: 'red',
    claim: 'a destructured rebinding of an exempt receiver (const { log } = deps) goes unnoticed',
    subject: 'nodeServer',
    anchor: 'const log = createLogger({ module: "server" });',
    replacement:
      'const log = createLogger({ module: "server" });\nfunction rebound(deps) {\n  const { log } = deps;\n  return log;\n}',
  },
  {
    id: 'R4-B3',
    expect: 'red',
    claim: 'the binding check no longer sees a destructuring pattern that binds the receiver',
    subject: 'spec',
    anchor:
      "    new RegExp(\n      String.raw`\\{[^{}]*${id}\\s*(?=[,}]|=(?![=>]))[^{}]*\\}\\s*(?::[^=;{}\\n]+)?=(?![=>])`,\n      'g',\n    ),\n",
    replacement: '',
  },
  {
    id: 'R4-B4',
    expect: 'red',
    claim: 'the binding check no longer sees an import of the receiver',
    subject: 'spec',
    anchor:
      "    new RegExp(\n      String.raw`\\bimport\\s+(?:type\\s+)?(?:${r}\\b|\\*\\s*as\\s+${r}\\b|[^;]*\\{[^}]*${id}\\s*[,}][^;]*from)`,\n      'g',\n    ),\n",
    replacement: '',
  },
  {
    id: 'R4-B5',
    expect: 'red',
    claim: 'the binding check no longer sees a re-assignment of the receiver (log = client)',
    subject: 'spec',
    anchor: "    new RegExp(String.raw`${id}\\s*(?:\\?\\?|\\|\\||&&)?=(?![=>])`, 'g'),\n",
    replacement: '',
  },
  {
    id: 'R4-B6',
    expect: 'red',
    claim: 'the binding check no longer sees a for (const log of …) loop binding',
    subject: 'spec',
    anchor:
      "    new RegExp(String.raw`\\b(?:const|let|var)\\s+${r}\\s*(?:=|\\s(?:of|in)\\b)`, 'g'),",
    replacement: "    new RegExp(String.raw`\\b(?:const|let|var)\\s+${r}\\s*=`, 'g'),",
  },
  // ── U: what must be UNPARSEABLE, never a pass ───────────────────────────────
  {
    id: 'U1',
    expect: 'red',
    claim: 'an optional or bound computed member (client?.[name](…), client[name].bind) passes',
    subject: 'scan',
    anchor:
      '    /[\\w$\\])]\\s*(?:\\?\\.)?\\s*\\[([^\\]\\n]+)\\]\\s*(?:(?:\\?\\.)?\\s*\\(|\\??\\.\\s*(?:bind|call|apply)\\s*\\()/g,',
    replacement: '    /[\\w$\\])]\\s*\\[([^\\]\\n]+)\\]\\s*\\(/g,',
  },
  {
    id: 'U2',
    expect: 'red',
    claim: 'a generic issuer handed on (client.call.bind(client)) passes',
    subject: 'scan',
    anchor: '          bad(start, `${site} referenced, not called: it can send any command`);',
    replacement: '          void 0;',
  },
  {
    id: 'U3',
    expect: 'red',
    claim: 'a computed key in a destructuring pattern passes',
    subject: 'scan',
    anchor: "        bad(m.index ?? 0, 'computed key in a destructuring pattern');",
    replacement: '        void 0;',
  },
  {
    id: 'U4',
    expect: 'red',
    claim: 'Reflect.get(client, name) with a non-literal property passes',
    subject: 'scan',
    anchor:
      "      if (name === null) bad(m.index ?? 0, 'Reflect.get with a non-literal property');",
    replacement: '      if (name === null) void 0;',
  },
  {
    id: 'U5',
    expect: 'red',
    claim: 'Reflect.apply on an unnamed target passes',
    subject: 'scan',
    anchor: "      bad(m.index ?? 0, 'Reflect.apply on a target that is not a named member');",
    replacement: '      void 0;',
  },
  // ── X: an exclusion widened past what it may drop ───────────────────────────
  {
    id: 'X1',
    expect: 'red',
    claim: 'the no-argument exclusion also drops commands that TAKE no argument (client.info())',
    subject: 'scan',
    anchor: '  return MEASURED.has(cmd) && !NO_ARG.has(cmd);',
    replacement: '  return MEASURED.has(cmd);',
  },
  {
    id: 'X2',
    expect: 'red',
    claim: "every argument counts as a function literal, so client.keys('*') is dropped",
    subject: 'scan',
    anchor:
      'const FUNCTION_LITERAL = /^(?:async\\s+)?(?:function\\b|\\([^()]*\\)\\s*=>|[\\w$]+\\s*=>)/;',
    replacement: 'const FUNCTION_LITERAL = /^/;',
  },
  {
    id: 'X3',
    expect: 'red',
    claim:
      "the Function.prototype.call exclusion drops every .call, so client.call('UNLINK') passes",
    subject: 'scan',
    anchor: "      if (lower === 'call' && first === 'this') continue;",
    replacement: "      if (lower === 'call') continue;",
  },
  {
    id: 'X4',
    expect: 'red',
    claim: 'a client-like name is treated as a language global',
    subject: 'scan',
    anchor: "  'console',\n]);",
    replacement: "  'console',\n  'client',\n]);",
  },
  // ── D: discovery ────────────────────────────────────────────────────────────
  {
    id: 'D1',
    expect: 'red',
    claim: 'a file only HANDED a client (client.unlink(k), no import) is not discovered',
    subject: 'spec',
    anchor: "  if (scan.hits.length > 0) return 'issues a command (any rule, any receiver)';",
    replacement: '  void 0;',
  },
  {
    id: 'D2',
    expect: 'red',
    claim: 'a file that only dispatches by a computed name is not discovered',
    subject: 'spec',
    anchor: "  if (scan.unparseable.length > 0) return 'has a construct the scan cannot resolve';",
    replacement: '  void 0;',
  },
  // ── B: a NOT_REDIS_RECEIVERS receiver rebound to a client ───────────────────
  {
    id: 'B1',
    expect: 'red',
    claim: "a second declaration of an allowlisted receiver (node-server.ts's log) goes unnoticed",
    subject: 'nodeServer',
    anchor: 'const log = createLogger({ module: "server" });',
    replacement:
      'const log = createLogger({ module: "server" });\nfunction rebound() {\n  const log = connectRedis();\n  return log;\n}',
  },
  // ── E: the spike's exit codes ───────────────────────────────────────────────
  {
    id: 'E1',
    expect: 'red',
    claim: "a spike user's ACL refusal is classified a crash (exit 3), not a finding (exit 1)",
    subject: 'spike',
    anchor: "  return user !== undefined && user === adminUser ? 'infrastructure' : 'acl';",
    replacement: "  return 'crash';",
  },
  {
    id: 'E2',
    expect: 'red',
    claim: 'an ACL finding maps to exit 3',
    subject: 'spike',
    anchor: "  return kind === 'usage' ? 2 : kind === 'acl' ? 1 : 3;",
    replacement: "  return kind === 'usage' ? 2 : 3;",
  },
  // ── L: live only (KNEXT_REDIS_LIVE_URL) ─────────────────────────────────────
  {
    id: 'L1',
    live: true,
    expect: 'red',
    // The first live run of this row SURVIVED: with the layer wrapper gone the
    // error reaches main's catch, which maps an ACL refusal to 1 as well, so
    // the --assert row could not tell the two apart. What only the wrapper
    // gives is a run that REACHES ITS END and reports the finding, so the row
    // is now killed by the report-only (no --assert) test, which needs exit 0.
    claim: 'a layer aborted by an ACL refusal ends the run instead of being reported as a finding',
    subject: 'spike',
    anchor: "      if (failureKind(err, adminUser) !== 'acl') throw err;",
    replacement: '      throw err;',
  },
  {
    id: 'L2',
    live: true,
    expect: 'red',
    claim: "the prune row's cutoff is 0 again, so HDEL never runs and --drop=hdel exits 0",
    subject: 'spike',
    anchor: "        '9007199254740991',",
    replacement: "        '0',",
  },
  {
    id: 'L3',
    live: true,
    expect: 'red',
    claim: 'no row sends DISCARD, so --drop=discard exits 0',
    subject: 'spike',
    anchor: "      seq: () => [['MULTI'], ['DISCARD']],",
    replacement: "      cmd: () => ['PING'],",
  },
];

const ACTIVE = MUTATIONS.filter((m) => !m.live || LIVE_URL !== '');

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    scan: 'tests/redis-command-scan.ts',
    spec: 'tests/redis-acl-spike.test.ts',
    spike: 'scripts/redis-acl-spike.mjs',
    nodeServer: 'packages/kn-next/src/adapters/node-server.ts',
    cacheHandler: 'packages/kn-next/src/adapters/cache-handler.js',
    commands: 'scripts/redis-commands.mjs',
  },
});

/** Run with the live lane on (L rows, baseline) or off (every other row). */
function withLive(on, run) {
  if (on) process.env.KNEXT_REDIS_LIVE_URL = LIVE_URL;
  else delete process.env.KNEXT_REDIS_LIVE_URL;
  try {
    return run();
  } finally {
    if (LIVE_URL !== '') process.env.KNEXT_REDIS_LIVE_URL = LIVE_URL;
  }
}

console.log(
  `=== mutation proof: ${SPEC} (Redis command scan, #2404) — ${ACTIVE.length} row(s)` +
    `${LIVE_URL === '' ? ', live rows not declared (KNEXT_REDIS_LIVE_URL unset)' : ', live rows included'} ===`,
);
prover.preflight(MUTATIONS);
declareMutations(ACTIVE.length);
withLive(LIVE_URL !== '', () => prover.baseline());
withLive(false, () =>
  prover.proveCanSeeRed({
    subject: 'scan',
    anchor: '    if (REDIS_COMMAND_SET.has(stem)) return stem;',
    replacement: '    if (REDIS_COMMAND_SET.has(stem)) return null;',
  }),
);

console.log('\n=== mutations ===');
for (const m of ACTIVE) {
  withLive(m.live === true, () => prover.run(m));
  recordMutation();
}
prover.finish(ACTIVE.length);
