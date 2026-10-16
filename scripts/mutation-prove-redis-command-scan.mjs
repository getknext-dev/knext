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
 * "an ACL refusal is a finding (1), not a crash (3)" mapping.
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
    anchor: '  const stem = /^(.+?)(?:buffer|stream)$/.exec(lower)?.[1];',
    replacement: '  const stem = /^(.+?)(?:stream)$/.exec(lower)?.[1];',
  },
  {
    id: 'S6',
    expect: 'red',
    claim: "callBuffer is not a generic issuer: client.callBuffer('UNLINK', …) is missed",
    subject: 'scan',
    anchor:
      "const GENERIC_ISSUERS = new Set(['call', 'pcall', 'send', 'sendcommand', 'callbuffer']);",
    replacement: "const GENERIC_ISSUERS = new Set(['call', 'pcall', 'send', 'sendcommand']);",
  },
  {
    id: 'S7',
    expect: 'red',
    claim: "ioredis's <cmd>Stream variant is not a command: client.zscanStream('k') is missed",
    subject: 'scan',
    anchor: '  const stem = /^(.+?)(?:buffer|stream)$/.exec(lower)?.[1];',
    replacement: '  const stem = /^(.+?)(?:buffer)$/.exec(lower)?.[1];',
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
    anchor: "const HELPERS = new Set(['command', 'rediscommand']);",
    replacement: "const HELPERS = new Set(['rediscommand']);",
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
    anchor: '    if (called && !NO_ARG.has(cmd) && passesNoRedisArgument(src, open)) continue;',
    replacement: '    if (called && passesNoRedisArgument(src, open)) continue;',
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
    claim: 'a layer aborted by an ACL refusal crashes the run: full-mode --drop=set exits 3',
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
    anchor: '  if (REDIS_COMMAND_SET.has(lower)) return lower;',
    replacement: '  if (REDIS_COMMAND_SET.has(lower)) return null;',
  }),
);

console.log('\n=== mutations ===');
for (const m of ACTIVE) {
  withLive(m.live === true, () => prover.run(m));
  recordMutation();
}
prover.finish(ACTIVE.length);
