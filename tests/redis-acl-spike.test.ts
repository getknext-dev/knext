import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aclRulesFor, escapeAclGlob, MINIMAL_COMMANDS } from '../scripts/redis-acl-spike.mjs';
import { REDIS_COMMANDS, REDIS_SUBCOMMANDS } from '../scripts/redis-commands.mjs';
import { type ScanResult, scanRedisCommands } from './redis-command-scan';

/**
 * The Redis ACL compatibility spike (scripts/redis-acl-spike.mjs,
 * docs/security/redis-acl-spike.md): can a knext app run its cache under an ACL
 * user restricted to `~<prefix>:*` and a minimal command set?
 *
 * Two halves:
 *
 *   - ALWAYS: the rule set's shape, and a SOURCE SCAN for every Redis command
 *     the runtime can issue, so a command the cache starts sending that is not in
 *     MINIMAL_COMMANDS reds here before a per-app ACL user refuses it (NOPERM).
 *
 *     WHICH FILES — discovered, not listed. Every git-tracked source file under
 *     `packages/<pkg>/src/` (tests, `.d.ts` and `__tests__` aside) that either
 *     references a Redis client (`ioredis`, `RedisClient`, a `'redis'` /
 *     `'@redis/client'` / `'iovalkey'` import, the shared helpers `redisCommand`,
 *     `createRedisClient`, `redis/client`) or issues a command through a
 *     generic issuer or helper with a literal Redis command (so a file that is
 *     only HANDED a client, like use-cache-handler.js, is found by what it
 *     sends). Every discovered file is scanned, except those under a directory
 *     in NOT_THE_APP_USER, each with the reason that code never runs as the
 *     app's ACL user. There is no "unclassified" state to fall into: a new file
 *     is scanned by default.
 *
 *     WHAT COUNTS AS A COMMAND — tests/redis-command-scan.ts: a call to ANY
 *     method whose name is a Redis command (canonical list,
 *     scripts/redis-commands.mjs, any receiver), `.call/.pcall/.send/
 *     .sendCommand` with the command first, `command/redisCommand(client, CMD)`,
 *     and `['CMD', …]` tuples. A command argument that is not a string literal,
 *     or a computed method call, is UNPARSEABLE and fails here unless it is an
 *     exact line in FORWARDERS with its justification.
 *
 *     WHAT IT DOES NOT SEE (stated, not hidden): a client reached through a
 *     computed specifier in a file with no other Redis reference; a tuple built
 *     from non-literals and handed to a listed forwarder; a receiver whose
 *     method name is a Redis command but which NOT_REDIS wrongly calls non-Redis.
 *     The live lane's real-handler layer (ACL LOG, MONITOR) is the backstop for
 *     the paths it exercises.
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

/** The connect-time commands ACL never gates (measured: AUTH, HELLO). */
const HANDSHAKE = new Set(['auth', 'hello']);

/** Directories whose code never runs as the app's ACL user, and why. */
const NOT_THE_APP_USER: Record<string, string> = {
  'packages/kn-next/src/cli/':
    'the CLI runs on a developer machine or in CI, never in the app pod; under ADR-0071 it never ' +
    'connects to Redis or holds the per-app credential (doctor reads the CR status)',
};

/**
 * Hits on a method named like a Redis command whose receiver is NOT a Redis
 * client. Keyed by file, then `receiver.method` exactly as the scan reports it.
 * Every entry must still occur, so a stale one reds.
 */
const NOT_REDIS: Record<string, Record<string, string>> = {
  'packages/kn-next/src/adapters/cache-handler.js': {
    'imageMemory.keys': 'a Map of in-memory image entries',
    'Object.keys': 'Object.keys over a plain object',
  },
  'packages/kn-next/src/adapters/metrics.ts': {
    'deepHealthState.reset': 'a prom-client gauge reset',
  },
  'packages/lib/src/health/index.ts': {
    'logger.info': 'the pino logger',
  },
};

/**
 * Lines whose command argument cannot be resolved statically, and why each is
 * safe. Matched on the exact trimmed line, so any edit to one re-opens it; every
 * entry must still occur, so a stale one reds.
 */
const FORWARDERS: Record<string, Record<string, string>> = {
  'packages/kn-next/src/adapters/cache-handler.js': {
    "return typeof close === 'function' ? () => close.call(target) : undefined;":
      "Function.prototype.call on the client's own close(), not a Redis command",
    'for (const [name, ...args] of commands) tx[name.toLowerCase()](...args);':
      "execAtomic's ioredis branch: replays its callers' ['CMD', …] tuples, which the tuple rule scans",
    'await client.send(name.toUpperCase(), args.map(String));':
      "execAtomic's / execBatch's native branch: the same tuples, on Bun's client",
    'for (const [name, ...args] of commands) pipe[name.toLowerCase()](...args);':
      "execBatch's ioredis branch: the event-log tuples (LPUSH, LTRIM)",
    "if (typeof client.multi === 'function') return await client.call(name, ...args);":
      'redisCommand itself (ioredis branch): every caller passes a literal, scanned at the call site',
    'return await client.send(name, args.map(String));':
      'redisCommand itself (native branch): same',
    'return { send: (name, args) => redisCall(() => redisCommand(client, name, args)) };':
      "the CDN purger's client adapter: purger.js's own client.send('SET', …) is scanned",
  },
  'packages/kn-next/src/adapters/use-cache-handler.js': {
    '*   breaker on a fault), `command(client, name, args)`, `keyPrefix()`,':
      'a doc comment naming the helper; comments are scanned too, on purpose',
  },
  'packages/kn-next/src/adapters/cdn-purge/purger.js': {
    'log[level](`[CdnPurge] ${message}`);': 'a logger dispatch by level, not a client',
  },
};

const REDIS_REFERENCE =
  /\bioredis\b|\biovalkey\b|\bRedisClient\b|['"](?:redis|@redis\/client)['"]|\bredisCommand\b|\bcreateRedisClient\b|\/redis\/client['"]/;

function sourceFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '-z', 'packages'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout
    .split('\0')
    .filter(
      (f) =>
        /^packages\/[^/]+\/src\//.test(f) &&
        /\.(?:[mc]?[jt]s|[jt]sx)$/.test(f) &&
        !/\.d\.[mc]?ts$/.test(f) &&
        !/(?:^|\/)__tests__\/|\.(?:test|spec)\.[^/]+$/.test(f),
    );
}

type Discovered = { file: string; scan: ScanResult; excludedBy?: string };

function discover(): Discovered[] {
  const out: Discovered[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const scan = scanRedisCommands(src);
    const issues = scan.hits.some((h) => h.via !== 'method' && h.via !== 'tuple');
    if (!REDIS_REFERENCE.test(src) && !issues) continue;
    const excludedBy = Object.keys(NOT_THE_APP_USER).find((dir) => file.startsWith(dir));
    out.push({ file, scan, excludedBy });
  }
  return out;
}

const DISCOVERED = discover();
const SCANNED = DISCOVERED.filter((d) => d.excludedBy === undefined);

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

  it('every command in the minimal set is a real Redis command', () => {
    for (const c of MINIMAL_COMMANDS) expect(REDIS_COMMANDS).toContain(c);
  });
});

describe('redis ACL spike: the command scanner (tests/redis-command-scan.ts)', () => {
  const commands = (src: string) => scanRedisCommands(src).hits.map((h) => h.command);

  // The three escapes the round-1 review proved green by exit code, plus siblings.
  it.each([
    ["await client.call('UNLINK', 'x');", 'unlink'],
    ["await redisCommand(c, 'EXPIRE', [k, '1']);", 'expire'],
    ["await conn.expire('k', 1);", 'expire'],
    ["await anyName?.sendCommand(['COPY', a, b]);", 'copy'],
    ['await this.r.send("FLUSHDB", []);', 'flushdb'],
    ["tx.multi(); tx.getdel('k');", 'getdel'],
    ['const t = [[\'unlink\', k]]; const u = ["Watch", k];', 'unlink'],
    ["  local v = redis.pcall('OBJECT', 'ENCODING', KEYS[1])", 'object'],
  ])('sees %s as %s', (src, cmd) => {
    expect(commands(src)).toContain(cmd);
  });

  it.each([
    ['await client.call(name, ...args);'],
    ['await redisCommand(client, cmd, args);'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
    ['await client.send(`${verb}`, []);'],
    ['await client.send(pick(), []);'],
    ['tx[name.toLowerCase()](...args);'],
  ])('reports %s as UNPARSEABLE, never as a pass', (src) => {
    expect(scanRedisCommands(src).unparseable.length).toBeGreaterThan(0);
  });

  it('a function declaration of a helper is not a call', () => {
    expect(scanRedisCommands('async function redisCommand(client, name, args) {}')).toEqual({
      hits: [],
      unparseable: [],
    });
  });

  it('the canonical list is the generated one: top-level commands and container subcommands', () => {
    expect(REDIS_COMMANDS.length).toBeGreaterThan(200);
    expect(REDIS_COMMANDS).toContain('unlink');
    expect(REDIS_COMMANDS.every((c) => !c.includes('|'))).toBe(true);
    expect(REDIS_SUBCOMMANDS).toContain('client|setinfo');
  });
});

describe('redis ACL spike: the runtime source scan', () => {
  it('discovers the cache runtime files by scanning (it is not vacuous)', () => {
    const files = new Set(SCANNED.map((d) => d.file));
    for (const f of [
      'packages/kn-next/src/adapters/cache-handler.js',
      'packages/kn-next/src/adapters/use-cache-handler.js',
      'packages/kn-next/src/adapters/cdn-purge/purger.js',
      'packages/lib/src/health/index.ts',
      'packages/lib/src/redis/client.ts',
    ]) {
      expect(files.has(f), `discovery no longer finds ${f}`).toBe(true);
    }
  });

  it('every NOT_THE_APP_USER directory still excludes something (no stale exclusion)', () => {
    for (const dir of Object.keys(NOT_THE_APP_USER)) {
      expect(
        DISCOVERED.some((d) => d.excludedBy === dir),
        `${dir} excludes nothing`,
      ).toBe(true);
    }
  });

  it('covers every Redis command the cache runtime issues', () => {
    const missing: string[] = [];
    for (const { file, scan } of SCANNED) {
      for (const h of scan.hits) {
        if (MINIMAL_COMMANDS.includes(h.command) || HANDSHAKE.has(h.command)) continue;
        if (NOT_REDIS[file]?.[h.site] !== undefined) continue;
        missing.push(`${h.command} via ${h.site} (${file}:${h.line})`);
      }
    }
    expect(
      missing,
      'a per-app Redis ACL user would refuse these with NOPERM: add them to MINIMAL_COMMANDS in ' +
        'scripts/redis-acl-spike.mjs and to the rule set in docs/security/redis-acl-spike.md, or, ' +
        'if the receiver is not a Redis client, add it to NOT_REDIS with the reason',
    ).toEqual([]);
  });

  it('every command argument it cannot resolve is a justified forwarder (unparseable is a failure)', () => {
    const unexplained: string[] = [];
    for (const { file, scan } of SCANNED) {
      for (const u of scan.unparseable) {
        if (FORWARDERS[file]?.[u.text] !== undefined) continue;
        unexplained.push(`${file}:${u.line} ${u.why}: ${u.text}`);
      }
    }
    expect(
      unexplained,
      'the scan cannot tell which Redis command these send: pass a string literal, or add the ' +
        'exact line to FORWARDERS with why its commands are scanned elsewhere',
    ).toEqual([]);
  });

  it('every NOT_REDIS and FORWARDERS entry still occurs (no stale exemption)', () => {
    const stale: string[] = [];
    const byFile = new Map(SCANNED.map((d) => [d.file, d.scan]));
    for (const [file, sites] of Object.entries(NOT_REDIS)) {
      const scan = byFile.get(file);
      for (const site of Object.keys(sites)) {
        if (!scan?.hits.some((h) => h.site === site)) stale.push(`NOT_REDIS ${file} ${site}`);
      }
    }
    for (const [file, lines] of Object.entries(FORWARDERS)) {
      const scan = byFile.get(file);
      for (const text of Object.keys(lines)) {
        if (!scan?.unparseable.some((u) => u.text === text))
          stale.push(`FORWARDERS ${file} ${text}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('the scan sees the commands it is meant to see (it is not vacuous)', () => {
    const all = new Set(SCANNED.flatMap((d) => d.scan.hits.map((h) => h.command)));
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

/** Run the spike; return its exit code. */
function spike(runtime: 'node' | 'bun', args: string[], url: string): number {
  const r = spawnSync(runtime, [SCRIPT, '--assert', ...args], {
    cwd: ROOT,
    env: { ...process.env, KNEXT_REDIS_ACL_SPIKE_URL: url },
    encoding: 'utf8',
    timeout: 90_000,
  });
  return r.status ?? -1;
}

describe('redis ACL spike: exit codes that need no Redis', () => {
  // 2 = usage error. A mutation proof that silently mutates nothing would pass.
  it.each([
    [['--drop=nosuch']],
    [['--drop=info']],
    [['--grant=nosuch']],
    [['--grant=get']],
    [['--bogus']],
  ])('%p is a usage error (exit 2), not a run', (args) => {
    expect(spike('node', [...args], 'redis://127.0.0.1:1')).toBe(2);
  });

  it('a non-loopback URL is a usage error (exit 2)', () => {
    expect(spike('node', [], 'redis://10.255.255.1:6379')).toBe(2);
  });

  it('an unreachable Redis is infrastructure (exit 3), never the finding code 1', () => {
    expect(spike('node', [], 'redis://127.0.0.1:1')).toBe(3);
  }, 30_000);
});

const LIVE_URL = process.env.KNEXT_REDIS_LIVE_URL ?? '';
const LIVE = LIVE_URL !== '';

describe.skipIf(!LIVE)('redis ACL spike: live Redis (KNEXT_REDIS_LIVE_URL)', () => {
  it("the canonical command list covers the live server's COMMAND LIST", async () => {
    const client = new Bun.RedisClient(LIVE_URL);
    try {
      const live = ((await client.send('COMMAND', ['LIST'])) as string[]).map((c) =>
        c.toLowerCase(),
      );
      const known = new Set([...REDIS_COMMANDS, ...REDIS_SUBCOMMANDS]);
      expect(
        live.filter((c) => !known.has(c)),
        'regenerate scripts/redis-commands.mjs: the scan would not see these as commands',
      ).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('passes under node (ioredis) with the minimal rule set', () => {
    expect(spike('node', [], LIVE_URL)).toBe(0);
  }, 120_000);

  it("passes under bun (Bun's native client) with the minimal rule set", () => {
    expect(spike('bun', [], LIVE_URL)).toBe(0);
  }, 120_000);

  // Mutation proofs: each must turn the run red with the FINDING code (1),
  // not a usage (2) or infrastructure (3) code.
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
      expect(spike('node', [...args], LIVE_URL)).toBe(1);
    }, 120_000);
  }
});
