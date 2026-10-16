import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aclRulesFor, escapeAclGlob, MINIMAL_COMMANDS } from '../scripts/redis-acl-spike.mjs';

/**
 * The Redis ACL compatibility spike (scripts/redis-acl-spike.mjs,
 * docs/security/redis-acl-spike.md): can a knext app run its cache under an ACL
 * user restricted to `~<prefix>:*` and a minimal command set?
 *
 * Two halves:
 *
 *   - ALWAYS: the rule set's shape, and a SCAN of the runtime sources for every
 *     Redis command they issue. A command added to the cache runtime that is not
 *     in MINIMAL_COMMANDS would be refused (NOPERM) under a per-app ACL user, so
 *     it reds here first. Scanned, not enumerated: an unknown client method is a
 *     failure, not a pass.
 *   - LIVE LANE (KNEXT_REDIS_LIVE_URL, loopback only, like the use-cache Lua
 *     lane): run the spike with `--assert` under node (ioredis) and bun (Bun's
 *     native client) — exit 0 — and mutation-prove it: dropping a command the
 *     runtime needs, or granting one an app must never have, must exit 1. Exit
 *     codes only; output is never grepped.
 *
 *   docker run -d --name knext-acl-spike -p 127.0.0.1:6409:6379 redis:7-alpine redis-server --save ''
 *   KNEXT_REDIS_LIVE_URL=redis://127.0.0.1:6409 bun test tests/redis-acl-spike.test.ts
 */

const ROOT = resolve(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'redis-acl-spike.mjs');
const ADAPTERS = join(ROOT, 'packages', 'kn-next', 'src', 'adapters');

/** The connect-time commands ACL never gates (measured: AUTH, HELLO). */
const HANDSHAKE = new Set(['auth', 'hello']);

/** Client methods that are not Redis commands. Anything else is one. */
const NON_COMMAND_METHODS = new Set([
  'call',
  'send',
  'connect',
  'disconnect',
  'quit',
  'on',
  'once',
  'removeListener',
  'pipeline',
  'duplicate',
]);

const RUNTIME_SOURCES = [
  join(ADAPTERS, 'cache-handler.js'),
  join(ADAPTERS, 'use-cache-handler.js'),
  join(ADAPTERS, 'cdn-purge', 'purger.js'),
  join(ROOT, 'packages', 'lib', 'src', 'health', 'index.ts'),
];

/**
 * Files scanned for client METHOD calls only. The health module also holds
 * string tuples of error codes (`['ECONNREFUSED', ...]`), which the
 * command-tuple shape would misread as commands.
 */
const METHOD_ONLY = new Set([join(ROOT, 'packages', 'lib', 'src', 'health', 'index.ts')]);

const COMMAND_SHAPES = [
  /(?:command|redisCommand)\(\s*client,\s*'([A-Z]+)'/g, // core.command(client, 'HSET', ...)
  /\bsend\(\s*'([A-Z]+)'/g, // Bun native: client.send('MULTI', [])
  /\[\s*'([A-Z]+)',/g, // command tuples: ['SET', key, ...]
  /redis\.call\(\s*'([A-Z]+)'/g, // inside the Lua scripts
];

function commandsIssuedBy(file: string): Set<string> {
  const src = readFileSync(file, 'utf8');
  const found = new Set<string>();
  if (!METHOD_ONLY.has(file)) {
    for (const re of COMMAND_SHAPES)
      for (const m of src.matchAll(re)) found.add(m[1].toLowerCase());
  }
  for (const m of src.matchAll(/\b(?:client|tx|pipe|redis)\.([a-zA-Z]+)\(/g)) {
    const method = m[1];
    if (NON_COMMAND_METHODS.has(method)) continue;
    found.add(method.toLowerCase());
  }
  // ioredis `multi()` is MULTI + EXEC on the wire.
  if (found.has('multi')) found.add('exec');
  return found;
}

describe('redis ACL spike: the minimal rule set', () => {
  it('scopes the user to its own prefix, colon included, with no channels and no default commands', () => {
    const rules = aclRulesFor({ prefix: 'kn-abc', password: 'p' });
    expect(rules.slice(0, 7)).toEqual([
      'reset',
      'on',
      '>p',
      '~kn-abc:*',
      'resetchannels',
      '-@all',
      '+get',
    ]);
    expect(rules.filter((r) => r.startsWith('~'))).toEqual(['~kn-abc:*']);
    expect(
      rules.filter((r) => r.startsWith('&') || r === 'allchannels' || r === 'allkeys'),
    ).toEqual([]);
    expect(rules.filter((r) => r.startsWith('+@'))).toEqual([]);
  });

  it('glob-escapes the prefix in the key pattern, so a metacharacter cannot widen it', () => {
    expect(escapeAclGlob('kn-*')).toBe('kn-\\*');
    expect(escapeAclGlob('a?b[c]\\')).toBe('a\\?b\\[c\\]\\\\');
    expect(aclRulesFor({ prefix: 'kn-*', password: 'p' })).toContain('~kn-\\*:*');
  });

  it('grants no command an app must never have', () => {
    for (const c of [
      'info',
      'keys',
      'flushall',
      'flushdb',
      'config',
      'acl',
      'client',
      'script',
      'evalsha',
      'publish',
      'subscribe',
      'monitor',
      'debug',
      'shutdown',
    ]) {
      expect(MINIMAL_COMMANDS).not.toContain(c);
    }
  });

  it('covers every Redis command the cache runtime issues (scanned from source)', () => {
    const missing: string[] = [];
    for (const file of RUNTIME_SOURCES) {
      for (const cmd of commandsIssuedBy(file)) {
        if (MINIMAL_COMMANDS.includes(cmd) || HANDSHAKE.has(cmd)) continue;
        missing.push(`${cmd} (${file.slice(ROOT.length + 1)})`);
      }
    }
    expect(
      missing,
      'a per-app Redis ACL user would refuse these with NOPERM: add them to MINIMAL_COMMANDS in ' +
        'scripts/redis-acl-spike.mjs and to the rule set in docs/security/redis-acl-spike.md, or ' +
        'add the method to NON_COMMAND_METHODS if it is not a Redis command',
    ).toEqual([]);
  });

  it('the scan sees the commands it is meant to see (it is not vacuous)', () => {
    const all = new Set(RUNTIME_SOURCES.flatMap((f) => [...commandsIssuedBy(f)]));
    for (const c of [
      'get',
      'set',
      'del',
      'sadd',
      'smembers',
      'multi',
      'exec',
      'eval',
      'hset',
      'hmget',
      'hscan',
      'scan',
      'time',
      'hget',
      'hdel',
      'lpush',
      'ltrim',
      'discard',
      'ping',
    ]) {
      expect(all.has(c), `scan no longer finds ${c}`).toBe(true);
    }
  });
});

const LIVE_URL = process.env.KNEXT_REDIS_LIVE_URL ?? '';
const LIVE = LIVE_URL !== '';

function spike(runtime: 'node' | 'bun', args: string[]): number {
  const r = spawnSync(runtime, [SCRIPT, '--assert', ...args], {
    cwd: ROOT,
    env: { ...process.env, KNEXT_REDIS_ACL_SPIKE_URL: LIVE_URL },
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (r.status === 2) throw new Error(`spike precondition failed: ${r.stderr}`);
  return r.status ?? -1;
}

describe.skipIf(!LIVE)('redis ACL spike: live Redis (KNEXT_REDIS_LIVE_URL)', () => {
  it('passes under node (ioredis) with the minimal rule set', () => {
    expect(spike('node', [])).toBe(0);
  }, 120_000);

  it("passes under bun (Bun's native client) with the minimal rule set", () => {
    expect(spike('bun', [])).toBe(0);
  }, 120_000);

  // Mutation proofs: each must turn the run red.
  for (const [args, why] of [
    [['--drop=time', '--matrix-only'], "the replay script's TIME is refused inside Lua"],
    [['--drop=eval', '--matrix-only'], 'the stamp scripts are refused'],
    [['--drop=scan', '--matrix-only'], 'the collapse sweep is refused'],
    [['--drop=multi', '--matrix-only'], 'the atomic ISR write is refused'],
    [['--grant=flushall', '--matrix-only'], 'a forbidden command became reachable'],
    [['--grant=info', '--matrix-only'], 'a pinned known gap changed'],
    [
      ['--drop=hmget', '--handler-only'],
      'the REAL handler hits NOPERM (ACL LOG), without the matrix',
    ],
  ] as const) {
    it(`goes red when ${why} (${args.join(' ')})`, () => {
      expect(spike('node', [...args])).toBe(1);
    }, 120_000);
  }
});
