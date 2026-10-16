import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  aclRulesFor,
  escapeAclGlob,
  exitCodeFor,
  failureKind,
  MINIMAL_COMMANDS,
} from '../scripts/redis-acl-spike.mjs';
import {
  REDIS_COMMANDS,
  REDIS_NO_ARG_COMMANDS,
  REDIS_SUBCOMMANDS,
} from '../scripts/redis-commands.mjs';
import { GLOBAL_RECEIVERS, type ScanResult, scanRedisCommands } from './redis-command-scan';

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
 *     `packages/<pkg>/src/` (tests, `.d.ts` and `__tests__` aside) that
 *     references a Redis client (`ioredis`, `RedisClient`, a `'redis'` /
 *     `'@redis/client'` / `'iovalkey'` import, the shared helpers `redisCommand`,
 *     `createRedisClient`, `redis/client`), OR in which the scan finds ANY hit
 *     (a method named like a Redis command on any receiver, an issuer, a helper,
 *     a tuple, a destructured command, a Reflect access), OR anything it cannot
 *     resolve (UNPARSEABLE). So a file that is only HANDED a client is found by
 *     what it calls: `client.unlink(k)` alone is enough. Every discovered file
 *     is scanned, except those under a directory in NOT_THE_APP_USER, each with
 *     the reason that code never runs as the app's ACL user. There is no
 *     "unclassified" state to fall into: a new file is scanned by default.
 *
 *     WHAT COUNTS AS A COMMAND — tests/redis-command-scan.ts, whose header is
 *     the full list: a method named like a command (or its ioredis `Buffer` /
 *     `Stream` variant) on any receiver, called, optionally called, bound /
 *     called / applied, passed to `Reflect.apply`, or assigned; `.call/.pcall/
 *     .send/.sendCommand/.callBuffer` and `new Command` with the command first;
 *     `command/redisCommand(client, CMD)`; `['CMD', …]` tuples; destructured
 *     command keys; `Reflect.get(x, 'cmd')` and `x['cmd'](…)`. A command it
 *     cannot resolve is UNPARSEABLE and fails here unless it is an exact line in
 *     FORWARDERS with its justification. Two exclusions, each principled and
 *     tested on both sides: a receiver that is a language global
 *     (GLOBAL_RECEIVERS: `Object.keys`, `console.info`), and a call that passes
 *     no Redis argument to a command that needs one (`map.keys()`,
 *     `rows.sort((a, b) => a - b)`), which Redis answers with a wrong-arity
 *     error before its ACL check (measured on both engines).
 *
 *     FALSE POSITIVES are explained, never skipped: NOT_REDIS_RECEIVERS (a
 *     receiver in one file, with the declaration that binds it to something
 *     that is not a client, and no other declaration of it in that file) and
 *     NOT_REDIS_LINES (an exact trimmed line). Every entry must still occur, so
 *     a stale one reds.
 *
 *     WHAT IT DOES NOT SEE (stated, not hidden): everything in the scanner
 *     header's own list (a command method stored in an array or object literal,
 *     a computed member read into a variable and invoked later, nested
 *     destructuring, a destructuring parameter, `with` / `eval` /
 *     `new Function` / a Proxy over the client); a client reached through a
 *     computed specifier in a file with no other signal at all; a tuple built
 *     from non-literals and handed to a listed forwarder; a receiver in
 *     NOT_REDIS_RECEIVERS rebound to a client through a PARAMETER of the same
 *     name. The live lane's real-handler layer (ACL LOG, MONITOR) is the
 *     backstop for the paths it exercises.
 *   - LIVE LANE (KNEXT_REDIS_LIVE_URL, loopback only, like the use-cache Lua
 *     lane): run the spike with `--assert` under node (ioredis) and bun (Bun's
 *     native client) — exit 0 — and mutation-prove it: dropping a command the
 *     runtime needs, or granting one an app must never have, must exit 1. Exit
 *     codes only; output is never grepped.
 *
 *   docker run -d --name knext-acl-spike -p 127.0.0.1:6409:6379 redis:7-alpine redis-server --save ''
 *   KNEXT_REDIS_LIVE_URL=redis://127.0.0.1:6409 bun test tests/redis-acl-spike.test.ts
 *
 * The scanner's own rules are mutation-proved by
 * scripts/mutation-prove-redis-command-scan.mjs (exit codes only).
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
 * Receivers that are not Redis clients, per file. `bindings` are the
 * declarations that bind the receiver to something that is not a client; each
 * must occur in the file, and every `const|let|var <receiver> =` in the file
 * must be one of them, so a second, client-valued declaration reds. Every entry
 * must still explain a hit.
 */
const NOT_REDIS_RECEIVERS: Record<string, Record<string, { bindings: string[]; why: string }>> = {
  'packages/kn-next/src/adapters/deferred-default-metrics.ts': {
    log: {
      bindings: ['readonly log?: { info: (obj: object, msg: string) => void };'],
      why: 'an injected logger, typed as one (INFO is a Redis command)',
    },
  },
  'packages/kn-next/src/adapters/deferred-supervisor-init.ts': {
    log: { bindings: ['readonly log?: StepLogger;'], why: 'an injected step logger' },
  },
  'packages/kn-next/src/adapters/image-cache-sync.ts': {
    log: {
      bindings: ['const log = opts.log ?? console;', 'const log = deps.log ?? console;'],
      why: 'an injected logger or console',
    },
    fs: {
      bindings: ['import { existsSync, promises as fs, constants as fsConstants } from "node:fs";'],
      why: "node:fs's promises API (fs.watch)",
    },
  },
  'packages/kn-next/src/adapters/metrics.ts': {
    deepHealthState: {
      bindings: ['const deepHealthState = new Gauge({'],
      why: 'a prom-client gauge reset',
    },
  },
  'packages/kn-next/src/adapters/node-server.ts': {
    log: { bindings: ['const log = createLogger({ module: "server" });'], why: 'the pino logger' },
  },
  'packages/kn-next/src/adapters/sandbox-fetch-debug.cjs': {
    dc: {
      bindings: ["const dc = require('node:diagnostics_channel');"],
      why: 'node:diagnostics_channel (subscribe/unsubscribe)',
    },
  },
  'packages/kn-next/src/adapters/sandbox-fetch-realm-debug.cjs': {
    dc: {
      bindings: ["const dc = require('node:diagnostics_channel');"],
      why: 'node:diagnostics_channel (subscribe/unsubscribe)',
    },
  },
  'packages/kn-next/src/utils/asset-upload.ts': {
    log: {
      bindings: ['const log = createLogger({ module: "asset-upload" });'],
      why: 'the pino logger',
    },
  },
  'packages/lib/src/health/index.ts': {
    logger: { bindings: ["import { logger } from '../logger';"], why: 'the pino logger' },
  },
};

/**
 * Hits on exact lines that are not Redis, and why. Matched on the exact trimmed
 * line, so any edit to one re-opens it; every entry must still occur.
 */
const NOT_REDIS_LINES: Record<string, Record<string, string>> = {
  'packages/db/src/migrate.ts': {
    'await deps.migrate(db, migrationsFolder);': "drizzle's migrator, injected for tests",
  },
  'packages/ffi/src/manifest.ts': {
    '.sort(byName);': 'Array#sort with a named comparator',
    'return { fns: [...fns.values()].sort(byName), records, enums };':
      'Array#sort with a named comparator',
  },
  'packages/grpc/src/skew.ts': {
    "export const ROLLOUT_ORDER = ['function', 'zone'] as const;":
      'a list of rollout stages, not a FUNCTION command tuple',
  },
  'packages/kn-next/src/adapters/asset-anchor-analyze.mjs': {
    'const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range"]);':
      'AST property names, not a TYPE command tuple',
  },
  'packages/kn-next/src/utils/logger.ts': {
    "* log.info({ imageTag: 'v1.0.0' }, 'Starting deployment');": 'a doc-comment example',
  },
  'packages/lib/src/clients.ts': {
    'const { Client: MinioClient } = loadMinioSdk() as {':
      "the MinIO SDK's Client class, not the CLIENT command",
  },
};

/**
 * Lines whose command argument cannot be resolved statically, and why each is
 * safe. Matched on the exact trimmed line, so any edit to one re-opens it; every
 * entry must still occur, so a stale one reds.
 */
const FORWARDERS: Record<string, Record<string, string>> = {
  'packages/kn-next/src/adapters/arp-primer.cjs': {
    'socket.send(payload, ARP_PRIMER_TARGET_PORT, gateway, () => {':
      'a dgram socket send, not a Redis client',
  },
  'packages/kn-next/src/adapters/bun-base-exe.mjs': {
    '* seam scan asserts that order. `uncurryThis(f)(self, ...args)` is `f.call(self, ...args)` through':
      'a comment about Function.prototype.call',
  },
  'packages/kn-next/src/adapters/cache-control-normalize.cjs': {
    'originalSetHeader.call(res, name, value);':
      "Function.prototype.call on Node's own ServerResponse#setHeader",
    'setHeader: (n, v) => originalSetHeader.call(res, n, v),':
      "Function.prototype.call on Node's own ServerResponse#setHeader",
  },
  'packages/kn-next/src/adapters/cache-handler.js': {
    "return typeof close === 'function' ? () => close.call(target) : undefined;":
      "Function.prototype.call on the client's own close(), not a Redis command",
    'const value = Reflect.get(target, prop, target);':
      "the client proxy's get trap: it forwards whatever member a call site names, and every " +
      'call site is scanned',
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
  'packages/kn-next/src/adapters/cdn-purge/purger.js': {
    'log[level](`[CdnPurge] ${message}`);': 'a logger dispatch by level, not a client',
  },
  'packages/kn-next/src/adapters/public-origin.cjs': {
    'const args = Array.prototype.slice.call(arguments);': 'Array#slice over arguments',
  },
  'packages/kn-next/src/adapters/sharp-native-extract.mjs': {
    'apply: (_t, thisArg, args) => Reflect.apply(get(), thisArg, args),':
      'a Proxy over the lazily loaded sharp function, not a client',
    'get: (_t, prop) => Reflect.get(get(), prop),': 'the same sharp Proxy',
  },
  'packages/kn-next/src/adapters/use-cache-handler.js': {
    '*   breaker on a fault), `command(client, name, args)`, `keyPrefix()`,':
      'a doc comment naming the helper; comments are scanned too, on purpose',
  },
  'packages/kn-next/src/utils/logger.ts': {
    'const value = Reflect.get(real as object, prop, receiver);':
      "the lazy pino logger's Proxy get trap",
  },
  'packages/lib/src/context/index.ts': {
    'const value = Reflect.get(real, prop, receiver);':
      "the request-context AsyncLocalStorage's Proxy get trap",
  },
};

const REDIS_REFERENCE =
  /\bioredis\b|\biovalkey\b|\bRedisClient\b|['"](?:redis|@redis\/client)['"]|\bredisCommand\b|\bcreateRedisClient\b|\/redis\/client['"]/;

/** Why a file is discovered, or null when it carries no Redis signal at all. */
function redisSignal(src: string, scan: ScanResult): string | null {
  if (REDIS_REFERENCE.test(src)) return 'references a Redis client';
  if (scan.hits.length > 0) return 'issues a command (any rule, any receiver)';
  if (scan.unparseable.length > 0) return 'has a construct the scan cannot resolve';
  return null;
}

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

type Discovered = { file: string; src: string; scan: ScanResult; excludedBy?: string };

function discover(): Discovered[] {
  const out: Discovered[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const scan = scanRedisCommands(src);
    if (redisSignal(src, scan) === null) continue;
    const excludedBy = Object.keys(NOT_THE_APP_USER).find((dir) => file.startsWith(dir));
    out.push({ file, src, scan, excludedBy });
  }
  return out;
}

const DISCOVERED = discover();
const SCANNED = DISCOVERED.filter((d) => d.excludedBy === undefined);

const textAt = (src: string, line: number) => (src.split('\n')[line - 1] ?? '').trim();
const receiverOf = (site: string) => site.slice(0, Math.max(0, site.lastIndexOf('.')));

/** Is this non-granted hit explained by NOT_REDIS_RECEIVERS or NOT_REDIS_LINES? */
function explained(file: string, src: string, h: ScanResult['hits'][number]): boolean {
  if (h.via === 'method' && NOT_REDIS_RECEIVERS[file]?.[receiverOf(h.site)] !== undefined)
    return true;
  return NOT_REDIS_LINES[file]?.[textAt(src, h.line)] !== undefined;
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

  // The seven escapes the round-2 review proved green by exit code (S1–S7 in
  // scripts/mutation-prove-redis-command-scan.mjs), plus siblings.
  it.each([
    ["await client.unlink?.('k');", 'unlink', 'S1 optional call'],
    ["const {unlink}=client; unlink('k');", 'unlink', 'S2 destructuring'],
    ['const { unlink: drop, get } = client;', 'unlink', 'S2 destructuring, renamed'],
    ['const { unlink }: Pick<Redis, "unlink"> = client;', 'unlink', 'S2 destructuring, annotated'],
    ["Reflect.apply(client.unlink, client, ['k']);", 'unlink', 'S3 Reflect.apply'],
    ['const del = client.unlink.bind(client);', 'unlink', 'S4 bind'],
    ["client.unlink.call(client, 'k');", 'unlink', 'S4 call'],
    ["client.unlink.apply(client, ['k']);", 'unlink', 'S4 apply'],
    ['const del = client.unlink;', 'unlink', 'S4 assigned'],
    ["await client.unlinkBuffer('k');", 'unlink', 'S5 Buffer variant'],
    ["await client.callBuffer('UNLINK', 'k');", 'unlink', 'S6 callBuffer'],
    ["client.zscanStream('k');", 'zscan', 'S7 Stream variant'],
    ["await client.sendCommand(new Redis.Command('UNLINK', ['k']));", 'unlink', 'new Command'],
    ["await Reflect.get(client, 'unlink')('k');", 'unlink', 'Reflect.get, literal'],
    ["await client['unlink']('k');", 'unlink', 'literal computed member'],
    ['await client\n    .multi()\n    .unlink(k)\n    .exec();', 'unlink', 'a multi-line chain'],
    ['await this.client.unlink(k);', 'unlink', 'a nested receiver'],
    ['await client.info();', 'info', 'a no-argument command called with none'],
  ])('sees %s as %s (%s)', (src, cmd) => {
    expect(commands(src)).toContain(cmd);
  });

  it.each([
    ['await client.call(name, ...args);'],
    ['await redisCommand(client, cmd, args);'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
    ['await client.send(`${verb}`, []);'],
    ['await client.send(pick(), []);'],
    ['tx[name.toLowerCase()](...args);'],
    ["client?.[name]('k');"],
    ["client[name]?.('k');"],
    ['const f = client[name].bind(client);'],
    ['const { [name]: f } = client;'],
    ["await client.callBuffer(name, 'k');"],
    ['Reflect.get(client, name);'],
    ["Reflect.apply(fn, client, ['k']);"],
    ['const send = client.call.bind(client);'],
    ['await new Command(name, args);'],
  ])('reports %s as UNPARSEABLE, never as a pass', (src) => {
    expect(scanRedisCommands(src).unparseable.length).toBeGreaterThan(0);
  });

  // Each exclusion, both halves: what it drops, and what it must keep.
  it.each([
    ['Object.keys(entries);', 'a language-global receiver'],
    ['console.info("x");', 'a language-global receiver'],
    ['const { keys: ObjectKeys } = Object;', 'destructured from a language global'],
    ['for (const k of byName.keys()) {}', 'no Redis argument'],
    ['rows.sort((a, b) => a.n - b.n);', 'only a function literal'],
    ['list.sort(function (a, b) { return a - b; });', 'only a function literal'],
    ['return originalSetHeader.call(this, name, value);', 'Function.prototype.call(this, …)'],
  ])('does not count %s (%s)', (src) => {
    expect(scanRedisCommands(src)).toEqual({ hits: [], unparseable: [] });
  });

  it.each([
    ["client.keys('*');", 'keys', 'the same name WITH a Redis argument'],
    ['client.sort(key, compare);', 'sort', 'an identifier could be a key'],
    ['log.info("x");', 'info', 'a receiver that is not a language global'],
    ['client.reset();', 'reset', 'RESET takes no argument, so none is still a call'],
    ['const { keys } = client;', 'keys', 'destructured from a non-global'],
  ])('still counts %s as %s (%s)', (src, cmd) => {
    expect(commands(src)).toContain(cmd);
  });

  it('every GLOBAL_RECEIVERS name is a real language global', () => {
    for (const name of GLOBAL_RECEIVERS) {
      expect(name in globalThis, `${name} is not a global`).toBe(true);
    }
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
    for (const c of REDIS_NO_ARG_COMMANDS) expect(REDIS_COMMANDS).toContain(c);
    for (const c of ['keys', 'sort', 'unlink', 'get', 'set']) {
      expect(REDIS_NO_ARG_COMMANDS).not.toContain(c);
    }
  });
});

describe('redis ACL spike: discovery', () => {
  it.each([
    ['export async function purge(client, k) { await client.unlink(k); }', 'is handed a client'],
    ['export const run = (c, op, k) => c[op](k);', 'only dispatches by a computed name'],
    ["import Redis from 'ioredis';", 'references a client'],
  ])('discovers a file that %s', (src) => {
    expect(redisSignal(src, scanRedisCommands(src))).not.toBeNull();
  });

  it('does not discover a file with no signal at all', () => {
    const src = 'export const add = (a: number, b: number) => a + b;';
    expect(redisSignal(src, scanRedisCommands(src))).toBeNull();
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
    for (const { file, src, scan } of SCANNED) {
      for (const h of scan.hits) {
        if (MINIMAL_COMMANDS.includes(h.command) || HANDSHAKE.has(h.command)) continue;
        if (explained(file, src, h)) continue;
        missing.push(`${h.command} via ${h.via} ${h.site} (${file}:${h.line})`);
      }
    }
    expect(
      missing,
      'a per-app Redis ACL user would refuse these with NOPERM: add them to MINIMAL_COMMANDS in ' +
        'scripts/redis-acl-spike.mjs and to the rule set in docs/security/redis-acl-spike.md, or, ' +
        'if the receiver is not a Redis client, add it to NOT_REDIS_RECEIVERS (with its binding) ' +
        'or the exact line to NOT_REDIS_LINES, with the reason',
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

  it('every NOT_REDIS_RECEIVERS binding holds: it occurs, and nothing else declares the receiver', () => {
    const problems: string[] = [];
    for (const [file, receivers] of Object.entries(NOT_REDIS_RECEIVERS)) {
      const src = DISCOVERED.find((d) => d.file === file)?.src ?? '';
      const lines = src.split('\n').map((l) => l.trim());
      for (const [receiver, { bindings }] of Object.entries(receivers)) {
        for (const binding of bindings) {
          if (!src.includes(binding))
            problems.push(`${file}: ${receiver}'s binding is gone: ${binding}`);
        }
        const decl = new RegExp(`\\b(?:const|let|var)\\s+${receiver}\\s*=`);
        for (const line of lines) {
          if (decl.test(line) && !bindings.some((b) => line.includes(b)))
            problems.push(`${file}: ${receiver} is also declared by: ${line}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every NOT_REDIS_RECEIVERS, NOT_REDIS_LINES and FORWARDERS entry still occurs (no stale exemption)', () => {
    const stale: string[] = [];
    const byFile = new Map(SCANNED.map((d) => [d.file, d]));
    for (const [file, receivers] of Object.entries(NOT_REDIS_RECEIVERS)) {
      const d = byFile.get(file);
      for (const receiver of Object.keys(receivers)) {
        const used = d?.scan.hits.some(
          (h) =>
            h.via === 'method' &&
            receiverOf(h.site) === receiver &&
            !MINIMAL_COMMANDS.includes(h.command),
        );
        if (!used) stale.push(`NOT_REDIS_RECEIVERS ${file} ${receiver}`);
      }
    }
    for (const [file, lines] of Object.entries(NOT_REDIS_LINES)) {
      const d = byFile.get(file);
      for (const text of Object.keys(lines)) {
        if (!d?.scan.hits.some((h) => textAt(d.src, h.line) === text))
          stale.push(`NOT_REDIS_LINES ${file} ${text}`);
      }
    }
    for (const [file, lines] of Object.entries(FORWARDERS)) {
      const d = byFile.get(file);
      for (const text of Object.keys(lines)) {
        if (!d?.scan.unparseable.some((u) => u.text === text))
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

describe('redis ACL spike: what an error that ends a run means (exit codes)', () => {
  const ADMIN = 'default';
  it.each([
    ["NOPERM User knext-spike-c-1 has no permissions to run the 'set' command", 'acl', 1],
    ['ERR ACL failure in script: No permissions to access a key', 'acl', 1],
    [
      "lifecycle user could not connect: NOPERM User knext-spike-c-1 has no permissions to run the 'set' command",
      'acl',
      1,
    ],
    ["NOPERM User default has no permissions to run the 'monitor' command", 'infrastructure', 3],
    ['connect ECONNREFUSED 127.0.0.1:6409', 'crash', 3],
    ['Command timed out', 'crash', 3],
  ])('%s is %s (exit %d)', (message, kind, code) => {
    expect(failureKind(new Error(message), ADMIN)).toBe(kind);
    expect(exitCodeFor(failureKind(new Error(message), ADMIN))).toBe(code);
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

  it('REDIS_NO_ARG_COMMANDS covers every live command that takes no argument', async () => {
    const client = new Bun.RedisClient(LIVE_URL);
    try {
      const info = (await client.send('COMMAND', ['INFO'])) as unknown[];
      const live = info
        .filter((row): row is unknown[] => Array.isArray(row))
        .filter((row) => Math.abs(Number(row[1])) <= 1)
        .map((row) => String(row[0]).toLowerCase());
      expect(live.length).toBeGreaterThan(10);
      expect(
        live.filter((c) => !REDIS_NO_ARG_COMMANDS.includes(c)),
        'regenerate REDIS_NO_ARG_COMMANDS: the scan would drop a no-argument call to these',
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
    [['--drop=hdel', '--matrix-only'], "the prune script's HDEL is refused inside Lua"],
    [['--drop=discard', '--matrix-only'], "Bun's transaction abort (DISCARD) is refused"],
    [['--grant=flushall', '--matrix-only'], 'a forbidden command became reachable'],
    [['--grant=info', '--matrix-only'], 'a pinned known gap changed'],
    [
      ['--drop=hmget', '--handler-only'],
      'the REAL handler hits NOPERM (ACL LOG), without the matrix',
    ],
    // The default (full) mode: the lifecycle user's first write is refused,
    // which used to surface as a crash (exit 3) instead of a finding.
    [['--drop=set'], "the full run's lifecycle user is refused its first write"],
  ] as const) {
    it(`goes red when ${why} (${args.join(' ')})`, () => {
      expect(spike('node', [...args], LIVE_URL)).toBe(1);
    }, 120_000);
  }
});
