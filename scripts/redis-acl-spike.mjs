#!/usr/bin/env node
/**
 * redis-acl-spike — can a knext app run its Redis cache under an ACL user that
 * is restricted to its own key prefix (`~<prefix>:*`) and a minimal command set?
 *
 * Results and the reasoning are in docs/security/redis-acl-spike.md. This is the
 * reproduction, and it doubles as a regression check: `--assert` exits non-zero
 * on ANY unexpected outcome, in either direction:
 *
 *   - a command the cache uses is refused (NOPERM) under the minimal rule set;
 *   - a command or key the app must NOT reach is allowed (a cross-app GET/SET/DEL,
 *     a Lua script that touches another app's hash, FLUSHALL, ACL SETUSER, ...);
 *   - the REAL cache handler, driven through ISR set/get/revalidateTag, the
 *     `'use cache'` handler, two forced Redis outages and their replays (one
 *     narrow, one collapsed to a prefix-wide SCAN + DEL), leaves an ACL LOG entry
 *     for the app user that is not on the expected list, or never reaches Redis
 *     at all (a handler that fell back to its in-memory cache would show no
 *     NOPERM and prove nothing, so the keys it wrote are checked too).
 *
 * Two layers, because each catches what the other cannot:
 *
 *   1. COMMAND MATRIX. Every command the runtime issues, with the file it comes
 *      from, run as app A against A's keys (must pass) and B's keys (must be
 *      NOPERM). The Lua scripts are imported from use-cache-handler.js, not
 *      copied. This is the "exact command list". It cannot see a command that a
 *      client library sends on its own (a handshake, a ready check).
 *   2. REAL HANDLER. cache-handler.js itself, under the ACL user, with the admin
 *      connection reading `ACL LOG` afterwards. This is what sees the library's
 *      own commands, and anything the matrix forgot. It cannot say which command
 *      it would have needed for a path it did not exercise, which is why the
 *      matrix exists.
 *
 * Run under node for the ioredis client, under bun for Bun's native client (the
 * two production client paths). Each run creates two throwaway ACL users with
 * random names and passwords, never prints a password, and removes the users
 * and their keys when it is done.
 *
 *   docker run -d --name knext-acl-spike -p 127.0.0.1:6409:6379 \
 *     redis:7-alpine redis-server --save '' --appendonly no
 *   KNEXT_REDIS_ACL_SPIKE_URL=redis://127.0.0.1:6409 node scripts/redis-acl-spike.mjs --assert
 *   KNEXT_REDIS_ACL_SPIKE_URL=redis://127.0.0.1:6409 bun  scripts/redis-acl-spike.mjs --assert
 *
 * Options:
 *   --assert          exit 1 on any unexpected outcome (default: report only)
 *   --json            print the full result as JSON instead of the table
 *   --drop=<cmd>      remove one command from the minimal rule set (mutation
 *                     proof: `--drop=time --assert` must exit 1)
 *   --grant=<cmd>     add one command to the minimal rule set (e.g. info)
 *   --matrix-only     skip the real-handler layer
 *   --handler-only    skip the command matrix (proves the handler layer goes red
 *                     on its own: `--drop=hmget --handler-only --assert` exits 1)
 *
 * The admin URL is read from KNEXT_REDIS_ACL_SPIKE_URL only — never REDIS_URL,
 * so this cannot be pointed at an app's Redis by accident — and must be a
 * loopback host. Exit codes, distinct so a caller can tell a finding from a
 * broken run:
 *
 *   0  ok (or, without --assert, unexpected outcomes reported but not failed)
 *   1  unexpected outcome(s), with --assert: the finding this script exists for
 *   2  usage error: an unknown argument, a --drop that is not in the minimal
 *      rule set, a --grant that is not a Redis command (scripts/redis-commands.mjs)
 *      or is already granted, KNEXT_REDIS_ACL_SPIKE_URL unset, not a URL, or
 *      not loopback
 *   3  infrastructure or crash: Redis unreachable, no ACL support, CLIENT INFO
 *      without an address, or any uncaught error
 */

import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REDIS_COMMANDS, REDIS_SUBCOMMANDS } from './redis-commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');
const ADAPTERS = join(REPO, 'packages', 'kn-next', 'src', 'adapters');
const requireFromCore = createRequire(join(REPO, 'packages', 'kn-next', 'package.json'));

const RUNTIME = typeof globalThis.Bun !== 'undefined' ? 'bun' : 'node';

// ─── The minimal rule set (the finding this spike exists to produce) ─────────

/**
 * Every command the knext cache runtime issues, as a Redis ACL `+cmd`. Origins
 * are in COMMANDS below; docs/security/redis-acl-spike.md carries the table.
 * Deliberately absent: INFO (ioredis's ready check; it tolerates NOPERM — see
 * the doc), EVALSHA/SCRIPT (the runtime sends EVAL only), SELECT (the URL the
 * operator would issue carries no db index), every pub/sub command (none used).
 */
export const MINIMAL_COMMANDS = Object.freeze([
  'get',
  'set',
  'del',
  'sadd',
  'smembers',
  'lpush',
  'ltrim',
  'lrange',
  'hget',
  'hset',
  'hdel',
  'hmget',
  'hscan',
  'scan',
  'eval',
  'time',
  'multi',
  'exec',
  'discard',
  'ping',
]);

/** Backslash-escape the Redis glob metacharacters, as the runtime's escapeGlob does. */
export function escapeAclGlob(text) {
  return text.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
}

/**
 * The `ACL SETUSER` arguments for one app. `reset` first so a re-run starts
 * from nothing; `resetchannels` so no pub/sub channel is reachable whatever
 * `acl-pubsub-default` says; `-@all` then an explicit allowlist.
 */
export function aclRulesFor({ prefix, password, commands = MINIMAL_COMMANDS }) {
  return [
    'reset',
    'on',
    `>${password}`,
    `~${escapeAclGlob(prefix)}:*`,
    'resetchannels',
    '-@all',
    ...commands.map((c) => `+${c}`),
  ];
}

// ─── Arguments and preconditions ─────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    assert: false,
    json: false,
    drop: [],
    grant: [],
    matrixOnly: false,
    handlerOnly: false,
  };
  for (const a of argv) {
    if (a === '--assert') opts.assert = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--matrix-only') opts.matrixOnly = true;
    else if (a === '--handler-only') opts.handlerOnly = true;
    else if (a.startsWith('--drop=')) opts.drop.push(a.slice(7).toLowerCase());
    else if (a.startsWith('--grant=')) opts.grant.push(a.slice(8).toLowerCase());
    else throw new UsageError(`unknown argument ${a}`);
  }
  // A mutation proof that silently drops nothing (a typo, a command the set never
  // had) runs the unmutated rule set and passes: refuse it rather than run it.
  for (const c of opts.drop) {
    if (!MINIMAL_COMMANDS.includes(c)) {
      throw new UsageError(
        `--drop=${c}: not in the minimal rule set (${MINIMAL_COMMANDS.join(' ')})`,
      );
    }
  }
  for (const c of opts.grant) {
    if (!REDIS_COMMANDS.includes(c) && !REDIS_SUBCOMMANDS.includes(c)) {
      throw new UsageError(`--grant=${c}: not a Redis command (scripts/redis-commands.mjs)`);
    }
    if (MINIMAL_COMMANDS.includes(c)) {
      throw new UsageError(`--grant=${c}: already in the minimal rule set, so it changes nothing`);
    }
  }
  return opts;
}

/** Exit 2: the invocation is wrong. */
class UsageError extends Error {}
/** Exit 3: the run could not happen (Redis unreachable, no ACL support, ...). */
class Infrastructure extends Error {}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function adminUrl() {
  const raw = process.env.KNEXT_REDIS_ACL_SPIKE_URL ?? '';
  if (raw === '') throw new UsageError('KNEXT_REDIS_ACL_SPIKE_URL is not set');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError('KNEXT_REDIS_ACL_SPIKE_URL is not a URL');
  }
  if (!LOOPBACK.has(u.hostname)) {
    throw new UsageError(
      `refusing non-loopback host ${u.hostname}: this creates and deletes ACL users`,
    );
  }
  return u;
}

function userUrl(admin, username, password) {
  const u = new URL(admin.href);
  u.username = encodeURIComponent(username);
  u.password = encodeURIComponent(password);
  u.pathname = '';
  return u.href;
}

// ─── Outcome helpers ─────────────────────────────────────────────────────────

// A refusal by ACL. Inside a Lua script Redis 7.4 reports it as
// `ERR ACL failure in script: No permissions to access a key`, not NOPERM.
const ACL_DENIAL = /NOPERM|ACL failure in script/;
const isNoPerm = (err) => typeof err?.message === 'string' && ACL_DENIAL.test(err.message);

/** Run one raw command; classify the result as ok / noperm / error. Never throws. */
async function attempt(client, cmd) {
  try {
    const reply = await client.call(cmd[0], ...cmd.slice(1));
    return { outcome: 'ok', reply };
  } catch (err) {
    return { outcome: isNoPerm(err) ? 'noperm' : 'error', message: firstLine(err) };
  }
}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/** A MULTI/EXEC through ioredis's own transaction path, as cache-handler.js issues it. */
async function attemptTx(client, commands) {
  try {
    const tx = client.multi();
    for (const [name, ...args] of commands) tx[name.toLowerCase()](...args);
    const results = await tx.exec();
    const failed = (results ?? []).find(([err]) => err);
    if (failed)
      return { outcome: isNoPerm(failed[0]) ? 'noperm' : 'error', message: firstLine(failed[0]) };
    return { outcome: 'ok' };
  } catch (err) {
    // A command refused at QUEUE time aborts the whole EXEC (EXECABORT); the
    // NOPERM is in the message ioredis builds from the queued replies.
    const text = `${firstLine(err)} ${(err?.previousErrors ?? []).map(firstLine).join(' ')}`;
    return { outcome: ACL_DENIAL.test(text) ? 'noperm' : 'error', message: text.trim() };
  }
}

// ─── Layer 1: the command matrix ─────────────────────────────────────────────

/**
 * Every command, with where it comes from. `k(p, rest)` builds a key under
 * prefix `p`, so the same row runs against A's keyspace (expect ok) and B's
 * (expect noperm). `keyless` rows run once and must pass.
 */
function commandRows(scripts) {
  const k = (p, rest) => `${p}:${rest}`;
  return [
    // cache-handler.js — ISR handler
    {
      cmd: (p) => ['GET', k(p, 'cache:/route')],
      origin: 'cache-handler.js get() — read an ISR entry',
    },
    {
      cmd: (p) => ['DEL', k(p, 'cache:/route')],
      origin: 'cache-handler.js #set(null) — delete one entry',
    },
    {
      cmd: (p) => ['SMEMBERS', k(p, 'tag:t1')],
      origin: 'cache-handler.js invalidateTagInRedis — read a tag index',
    },
    {
      tx: (p) => [
        ['SET', k(p, 'cache:/route'), '{}', 'EX', '60'],
        ['SADD', k(p, 'tag:t1'), '/route'],
      ],
      origin: 'cache-handler.js #set → execAtomic — MULTI · SET EX · SADD · EXEC',
    },
    {
      tx: (p) => [
        ['DEL', k(p, 'cache:/route')],
        ['DEL', k(p, 'tag:t1')],
      ],
      origin: 'cache-handler.js invalidateTagInRedis → execAtomic — MULTI · DEL… · EXEC',
    },
    {
      cmd: (p) => ['SET', k(p, 'build-live:b1'), '1', 'EX', '90'],
      origin: 'cache-handler.js touchBuildLive — build liveness beat',
    },
    { cmd: (p) => ['GET', k(p, 'build-live:b1')], origin: 'cache-handler.js isBuildLive' },
    {
      cmd: (p) => ['LPUSH', k(p, 'cache-events'), '{}'],
      origin: 'cache-handler.js logCacheEvent → execBatch — event log',
    },
    {
      cmd: (p) => ['LTRIM', k(p, 'cache-events'), '0', '199'],
      origin: 'cache-handler.js logCacheEvent',
    },
    {
      cmd: (p) => ['SCAN', '0', 'MATCH', `${p}:cache:*`, 'COUNT', '200'],
      origin: 'cache-handler.js collapse sweep — SCAN MATCH <prefix>:cache:* (then DEL)',
      keyless: true,
    },
    // use-cache-handler.js — 'use cache' backend
    {
      cmd: (p) => ['GET', k(p, 'uc:default:ck')],
      origin: "use-cache-handler.js doGet — read a 'use cache' entry",
    },
    {
      cmd: (p) => ['SET', k(p, 'uc:default:ck'), '{}', 'EX', '300'],
      origin: 'use-cache-handler.js doSet — SET EX',
    },
    {
      cmd: (p) => ['HMGET', k(p, 'uc:tags'), 's:t1', 'e:t1'],
      origin: 'use-cache-handler.js doGet / doGetExpiration — tag stamps',
    },
    {
      cmd: (p) => ['HSET', k(p, 'uc:tags'), 's:t1', '1', 'e:t1', '1'],
      origin: 'use-cache-handler.js doUpdateTags / replay — HSET stamps',
    },
    {
      cmd: (p) => ['HSCAN', k(p, 'uc:tags'), '0', 'COUNT', '100'],
      origin: 'use-cache-handler.js pruneStamps — HSCAN the stamp hash',
    },
    {
      cmd: (p) => ['EVAL', scripts.PRUNE_STAMPS_SCRIPT, '1', k(p, 'uc:tags'), '0', 's:t1'],
      origin: 'use-cache-handler.js pruneStamps — EVAL PRUNE_STAMPS_SCRIPT (HGET, HDEL inside)',
    },
    {
      cmd: (p) => [
        'EVAL',
        scripts.REPLAY_STAMPS_SCRIPT,
        '1',
        k(p, 'uc:tags'),
        's:t1',
        '0',
        'e:t1',
        '0',
      ],
      origin: 'use-cache-handler.js replay — EVAL REPLAY_STAMPS_SCRIPT (TIME, HGET, HSET inside)',
    },
    {
      cmd: (p) => ['SCAN', '0', 'MATCH', `${p}:uc:*`, 'COUNT', '200'],
      origin: 'use-cache-handler.js replayCollapsedTags — SCAN MATCH <prefix>:uc:* (then DEL)',
      keyless: true,
    },
    {
      cmd: () => ['TIME'],
      origin: 'use-cache-handler.js clockOffset — Redis clock',
      keyless: true,
    },
    // Health and the reference app
    {
      cmd: () => ['PING'],
      origin: '@getknext/lib health deep check — redis.ping()',
      keyless: true,
    },
    {
      cmd: (p) => ['LRANGE', k(p, 'cache-events'), '0', '50'],
      origin: 'apps/file-manager /api/cache/events GET (reference app, not core)',
    },
  ];
}

/** Things app A must never be able to do, whatever the rule set grows into. */
function forbiddenRows(scripts, prefixA, prefixB) {
  return [
    { cmd: ['FLUSHALL'], why: 'wipes every app' },
    { cmd: ['FLUSHDB'], why: 'wipes every app in the db' },
    { cmd: ['KEYS', '*'], why: 'enumerates every key, blocking' },
    { cmd: ['CONFIG', 'GET', 'requirepass'], why: 'server config' },
    { cmd: ['ACL', 'SETUSER', 'mallory', 'on', '>x', '~*', '+@all'], why: 'privilege escalation' },
    { cmd: ['ACL', 'LIST'], why: 'reads every user and its password hash' },
    { cmd: ['SCRIPT', 'FLUSH'], why: 'drops every cached script' },
    {
      cmd: ['EVALSHA', '0000000000000000000000000000000000000000', '0'],
      why: 'not used by the runtime',
    },
    { cmd: ['PUBLISH', 'chan', 'x'], why: 'no pub/sub in the runtime; resetchannels' },
    { cmd: ['CLIENT', 'LIST'], why: 'other apps’ connections' },
    { cmd: ['CLIENT', 'KILL', 'USER', 'default'], why: 'disconnects other apps' },
    { cmd: ['SHUTDOWN', 'NOSAVE'], why: 'admin' },
    {
      cmd: ['EVAL', "return redis.call('HSET', ARGV[1], 'f', '1')", '0', `${prefixB}:uc:tags`],
      why: 'a script writing another app’s hash through an UNDECLARED key',
    },
    {
      cmd: ['EVAL', scripts.REPLAY_STAMPS_SCRIPT, '1', `${prefixB}:uc:tags`, 's:t1', '0'],
      why: 'the shipped replay script aimed at another app’s hash',
    },
    {
      cmd: ['SET', `${prefixA}x:cache:/route`, '{}'],
      why: 'a prefix that merely STARTS WITH the app’s (the pattern is <prefix>:*, colon included)',
    },
    {
      cmd: ['SET', `knext:cdn:purged:abc:b1`, '1', 'NX', 'EX', '60'],
      why: 'outside the prefix (see CDN row)',
    },
  ];
}

/**
 * Known gaps: rows whose CURRENT behaviour under the minimal rule set is a
 * NOPERM the runtime tolerates. Pinned so the spike notices if it changes, and
 * listed in the doc as work for the per-app ACL user build.
 */
function knownGapRows(cdnTagPrefix) {
  return [
    {
      cmd: ['SET', `knext:cdn:purged:${cdnTagPrefix}:b1`, '1', 'NX', 'EX', '86400'],
      origin: 'cdn-purge/purger.js claim — first-ready purge dedup key, OUTSIDE <prefix>:',
      expect: 'noperm',
      consequence:
        'the first-ready edge purge is skipped (logged; the edge stays stale until its TTL)',
    },
    {
      cmd: ['INFO'],
      origin:
        'ioredis ready check (enableReadyCheck, default on) — sent by the library on every connect',
      expect: 'noperm',
      consequence:
        'ioredis logs "Skipping the ready check because INFO command fails" and proceeds',
    },
    {
      cmd: ['CLIENT', 'SETINFO', 'LIB-NAME', 'ioredis'],
      origin:
        'ioredis client identity (disableClientInfo, default off) — sent by the library on every connect',
      expect: 'noperm',
      consequence:
        'ioredis swallows the error; each connect adds two ACL LOG entries (LIB-NAME, LIB-VER)',
    },
  ];
}

async function runMatrix({ Redis, admin, adminClient, a, b, scripts, cdnTagPrefix }) {
  const results = [];
  const clientA = new Redis(userUrl(admin, a.username, a.password), {
    lazyConnect: true,
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
  });
  await clientA.connect();
  try {
    for (const row of commandRows(scripts)) {
      const own = row.tx
        ? await attemptTx(clientA, row.tx(a.prefix))
        : await attempt(clientA, row.cmd(a.prefix));
      results.push({
        layer: 'matrix',
        kind: 'used',
        origin: row.origin,
        target: 'own',
        command: row.tx
          ? row
              .tx(a.prefix)
              .map((c) => c[0])
              .join(' · ')
          : row.cmd(a.prefix)[0],
        expect: 'ok',
        ...own,
      });
      if (row.keyless) continue;
      const other = row.tx
        ? await attemptTx(clientA, row.tx(b.prefix))
        : await attempt(clientA, row.cmd(b.prefix));
      results.push({
        layer: 'matrix',
        kind: 'used',
        origin: row.origin,
        target: 'other-app',
        command: row.tx
          ? row
              .tx(b.prefix)
              .map((c) => c[0])
              .join(' · ')
          : row.cmd(b.prefix)[0],
        expect: 'noperm',
        ...other,
      });
    }
    for (const row of forbiddenRows(scripts, a.prefix, b.prefix)) {
      results.push({
        layer: 'matrix',
        kind: 'forbidden',
        origin: row.why,
        target: 'n/a',
        command: row.cmd.slice(0, row.cmd[0] === 'EVAL' ? 1 : 2).join(' '),
        expect: 'noperm',
        ...(await attempt(clientA, row.cmd)),
      });
    }
    for (const row of knownGapRows(cdnTagPrefix)) {
      results.push({
        layer: 'matrix',
        kind: 'known-gap',
        origin: row.origin,
        target: 'n/a',
        command: row.cmd.slice(0, row.cmd[0] === 'CLIENT' ? 2 : 1).join(' '),
        expect: row.expect,
        consequence: row.consequence,
        ...(await attempt(clientA, row.cmd)),
      });
    }
    // Residual, measured rather than asserted away: SCAN has no key argument,
    // so a key pattern cannot filter what it RETURNS. A's SCAN with B's MATCH
    // lists B's key NAMES (never values). Recorded as an observation.
    const seedB = [`${b.prefix}:cache:/b-private-path`, `${b.prefix}:tag:b-private-tag`];
    for (const key of seedB) await adminClient.set(key, 'b');
    const leak = await attempt(clientA, ['SCAN', '0', 'MATCH', `${b.prefix}:*`, 'COUNT', '1000']);
    results.push({
      layer: 'matrix',
      kind: 'observation',
      origin: 'SCAN MATCH <other-app prefix>:* as app A — key names visible?',
      target: 'other-app',
      command: 'SCAN',
      expect: 'ok',
      outcome: leak.outcome,
      observed:
        leak.outcome === 'ok'
          ? `${(leak.reply?.[1] ?? []).length} of B's key names returned`
          : leak.message,
    });
    // Nested prefixes: an app whose prefix is `<A's prefix>:<more>` lives
    // INSIDE A's pattern, so A's user reaches its keys. The admission pattern
    // allows colons in keyPrefix, so per-app ACLs must refuse nesting
    // separately. Pinned: the row expects the reach, so a change shows.
    const nestedKey = `${a.prefix}:nested-app:cache:/route`;
    await adminClient.set(nestedKey, 'nested');
    results.push({
      layer: 'matrix',
      kind: 'known-gap',
      origin: "GET <A's prefix>:nested-app:… — a second app whose prefix nests inside A's",
      target: 'other-app',
      command: 'GET',
      expect: 'ok',
      consequence:
        "A's pattern covers the nested app's keys; nesting must be refused by the operator",
      ...(await attempt(clientA, ['GET', nestedKey])),
    });
  } finally {
    clientA.disconnect();
  }
  return results;
}

// ─── Layer 2: the real cache handler under the ACL user ──────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function streamOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function aclLogEntries(raw) {
  // RESP2: an array of flat [field, value, ...] arrays.
  return (raw ?? []).map((flat) => {
    const e = {};
    for (let i = 0; i + 1 < flat.length; i += 2) e[String(flat[i])] = flat[i + 1];
    return e;
  });
}

/**
 * One forced outage: pause the server so A's next command times out and trips
 * the breaker, queue invalidations while it is open, then let it close and
 * touch both handlers so the replays run.
 */
async function outage({ adminClient, isr, uc, isrTags, ucTags, cooldownMs }) {
  await adminClient.call('CLIENT', 'PAUSE', '1200', 'ALL');
  await isr.get('/probe', { kind: 'FETCH', tags: [] }); // times out → breaker opens
  await isr.revalidateTag(isrTags); // skipped → kept for replay
  await uc.updateTags(ucTags, {}); // skipped → kept for replay
  await sleep(cooldownMs + 1500);
  await isr.get('/after', { kind: 'FETCH', tags: [] }); // breaker closed → replay starts
  await uc.get('after', []);
  await sleep(1500); // replays are started, never awaited by the caller
}

async function runRealHandler({ Redis, admin, a, b, cdnTagPrefix }) {
  const adminClient = new Redis(admin.href, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await adminClient.connect();
  const findings = [];
  const observed = new Set();
  const cooldownMs = 1000;
  let monitorConn;
  try {
    // B's sentinel: must survive A's collapse sweep untouched.
    await adminClient.set(`${b.prefix}:cache:/sentinel`, 'b-owns-this');
    await adminClient.call('ACL', 'LOG', 'RESET');

    // Every command Redis EXECUTES for the handler, including those a Lua script
    // runs (source "lua") — the exact command list, from the server's side.
    // Denied commands never execute, so they are in ACL LOG, not here.
    // The admin connection is excluded by its SERVER-side address (`CLIENT
    // INFO`): behind Docker's port proxy the client's local port is not what
    // Redis sees, so that comparison silently excluded nothing.
    const adminAddr = /\baddr=(\S+)/.exec(String(await adminClient.call('CLIENT', 'INFO')))?.[1];
    if (!adminAddr)
      throw new Infrastructure('CLIENT INFO returned no addr; cannot separate admin traffic');
    const monitor = await adminClient.monitor();
    monitorConn = monitor;
    monitor.on('monitor', (_time, args, source) => {
      if (String(source) === adminAddr) return;
      const name = String(args[0]).toLowerCase();
      const full = name === 'client' ? `client|${String(args[1]).toLowerCase()}` : name;
      observed.add(String(source) === 'lua' ? `${full} (in Lua)` : full);
    });

    Object.assign(process.env, {
      REDIS_URL: userUrl(admin, a.username, a.password),
      REDIS_KEY_PREFIX: a.prefix,
      KNEXT_BUILD_ID: 'spike-build',
      REDIS_COMMAND_TIMEOUT_MS: '300',
      REDIS_RETRY_COOLDOWN_MS: String(cooldownMs),
      REDIS_CONNECT_TIMEOUT_MS: '2000',
      KNEXT_CDN_TAG_PREFIX: cdnTagPrefix,
    });
    const mod = await import(
      `${pathToFileURL(join(ADAPTERS, 'cache-handler.js')).href}?acl-spike=${Date.now()}`
    );
    const { CacheHandler } = mod;
    const isr = new CacheHandler({});
    const uc = CacheHandler.forUseCache('default');
    const fetchEntry = {
      kind: 'FETCH',
      data: { headers: {}, body: 'aGk=', status: 200, url: 'http://spike.invalid/' },
      revalidate: 60,
    };

    // Happy path: ISR write/read/invalidate, 'use cache' write/read/tags.
    await isr.set('/route', fetchEntry, { fetchCache: true, tags: ['isr-t1'], revalidate: 60 });
    const isrHit = await isr.get('/route', { kind: 'FETCH', tags: ['isr-t1'] });
    await uc.set(
      'ck1',
      Promise.resolve({
        value: streamOf('uc-body'),
        tags: ['uc-t1'],
        stale: 0,
        timestamp: Date.now(),
        expire: 300,
        revalidate: 60,
      }),
    );
    const ucHit = await uc.get('ck1', []);
    await uc.getExpiration(['uc-t1']);
    await uc.updateTags(['uc-t1'], {});
    await isr.revalidateTag(['isr-t1']);

    // Prove the handler really reached Redis as A (not its in-memory fallback).
    const ownKeys = await adminClient.call(
      'SCAN',
      '0',
      'MATCH',
      `${escapeAclGlob(a.prefix)}:*`,
      'COUNT',
      '10000',
    );
    const ownKeyCount = (ownKeys?.[1] ?? []).length;
    findings.push({
      check: 'handler wrote under its own prefix as the ACL user',
      ok: ownKeyCount > 0 && isrHit != null && ucHit != null,
      observed: `${ownKeyCount} keys under ${a.prefix}:*; ISR hit=${isrHit != null}; 'use cache' hit=${ucHit != null}`,
    });

    // Outage 1: narrow replay (a few tags) — ISR per-tag SMEMBERS/DEL, 'use cache' EVAL REPLAY_STAMPS_SCRIPT.
    await outage({ adminClient, isr, uc, isrTags: ['isr-r1'], ucTags: ['uc-r1'], cooldownMs });
    const replayed = await adminClient.hget(`${a.prefix}:uc:tags`, 's:uc-r1');
    findings.push({
      check: "the narrow 'use cache' replay ran (EVAL REPLAY_STAMPS_SCRIPT wrote its stamp)",
      ok: replayed != null,
      observed: replayed != null ? 'stamp s:uc-r1 present' : 'stamp missing — the replay never ran',
    });

    // Outage 2: over the 1000-tag bound — both replays collapse to SCAN MATCH + DEL.
    // Fresh entries first, so the sweep has something to delete.
    await isr.set('/route2', fetchEntry, { fetchCache: true, tags: ['isr-t2'], revalidate: 60 });
    await uc.set(
      'ck2',
      Promise.resolve({
        value: streamOf('uc-body-2'),
        tags: ['uc-t2'],
        stale: 0,
        timestamp: Date.now(),
        expire: 300,
        revalidate: 60,
      }),
    );
    const many = Array.from({ length: 1001 }, (_, i) => `bulk-${i}`);
    await outage({ adminClient, isr, uc, isrTags: many, ucTags: many, cooldownMs });
    const left = async (pattern) =>
      ((await adminClient.call('SCAN', '0', 'MATCH', pattern, 'COUNT', '10000'))?.[1] ?? []).length;
    const isrLeft = await left(`${escapeAclGlob(a.prefix)}:cache:*`);
    const ucLeft = await left(`${escapeAclGlob(a.prefix)}:uc:default:*`);
    findings.push({
      check: 'both collapsed replays swept the prefix (SCAN MATCH + DEL as the ACL user)',
      ok: isrLeft === 0 && ucLeft === 0,
      observed: `${isrLeft} ISR entries and ${ucLeft} 'use cache' entries left under ${a.prefix}`,
    });

    const sentinel = await adminClient.get(`${b.prefix}:cache:/sentinel`);
    findings.push({
      check: "app B's key survives app A's collapse sweep",
      ok: sentinel === 'b-owns-this',
      observed: sentinel === 'b-owns-this' ? 'intact' : `got ${sentinel}`,
    });

    const log = aclLogEntries(await adminClient.call('ACL', 'LOG', '1000')).filter(
      (e) => String(e.username) === a.username,
    );
    // The client libraries' own connect-time commands; see knownGapRows. Both
    // are swallowed by the library, so they cost an ACL LOG entry, not a fault.
    const expectedDenials = new Set(['info', 'client|setinfo']);
    const denied = [...new Set(log.map((e) => `${e.reason}:${e.object}`))];
    const unexpected = log.filter(
      (e) => !(e.reason === 'command' && expectedDenials.has(String(e.object))),
    );
    findings.push({
      check: 'ACL LOG for the app user holds only expected denials',
      ok: unexpected.length === 0,
      observed: denied.length === 0 ? 'no entries' : denied.join(', '),
    });

    const executed = [...observed].sort();
    // AUTH (ioredis) and HELLO (Bun's native client, RESP3) are the handshake.
    // Measured: both execute for a `-@all` user with no grant and leave no ACL
    // LOG entry, so they need none.
    const granted = new Set([...MINIMAL_COMMANDS, 'auth', 'hello']);
    const outside = executed.filter((c) => !granted.has(c.replace(/ \(in Lua\)$/, '')));
    findings.push({
      check: 'every command the handler executed is in the minimal rule set',
      ok: executed.length > 0 && outside.length === 0,
      observed: `executed: ${executed.join(', ')}${outside.length ? ` — OUTSIDE: ${outside.join(', ')}` : ''}`,
      executed,
    });
  } finally {
    monitorConn?.disconnect();
    adminClient.disconnect();
  }
  return findings;
}

// ─── Layer 3: the user's lifecycle (what provisioning has to live with) ──────

/**
 * Re-assertion, rotation and deletion, measured on a live connection — the
 * three things an operator that owns the user does to it. Not a property of the
 * cache runtime; a property of Redis that the provisioning design rests on.
 */
async function runLifecycle({ Redis, admin, adminClient, commands }) {
  const tag = randomBytes(4).toString('hex');
  const c = {
    username: `knext-spike-c-${tag}`,
    prefix: `spike-c-${tag}`,
    password: randomBytes(24).toString('hex'),
  };
  const next = randomBytes(24).toString('hex');
  const open = async (password) => {
    const conn = new Redis(userUrl(admin, c.username, password), {
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    let lastError;
    conn.on('error', (err) => {
      lastError = err;
    });
    try {
      await conn.connect();
      await conn.set(`${c.prefix}:k`, '1');
      return { conn, ok: true };
    } catch (err) {
      conn.disconnect();
      // ioredis reports the AUTH refusal on 'error' and rejects connect() with
      // a generic 'Connection is closed'; the refusal is the one that matters.
      return { conn: null, ok: false, message: firstLine(lastError ?? err) };
    }
  };
  const works = async (conn) => {
    try {
      return (await conn.get(`${c.prefix}:k`)) === '1';
    } catch {
      return false;
    }
  };
  const findings = [];
  const conns = [];
  try {
    await adminClient.call('ACL', 'SETUSER', c.username, ...aclRulesFor({ ...c, commands }));
    const live = await open(c.password);
    if (!live.ok) throw new Error(`lifecycle user could not connect: ${live.message}`);
    conns.push(live.conn);

    // 1. Re-assert the identical rule set (what an idempotent reconcile does,
    //    and what restores the user after a restart that lost it).
    await adminClient.call('ACL', 'SETUSER', c.username, ...aclRulesFor({ ...c, commands }));
    findings.push({
      check: 'lifecycle: re-asserting the same rules (reset … >pw) keeps live connections working',
      ok: await works(live.conn),
      observed: (await works(live.conn)) ? 'live connection unaffected' : 'live connection broken',
    });

    // 2. Rotation, overlap first: add the new password, then remove the old one.
    await adminClient.call('ACL', 'SETUSER', c.username, `>${next}`);
    const both = [await open(c.password), await open(next)];
    for (const o of both) if (o.conn) conns.push(o.conn);
    await adminClient.call('ACL', 'SETUSER', c.username, `<${c.password}`);
    const oldAfter = await open(c.password);
    const newAfter = await open(next);
    if (newAfter.conn) conns.push(newAfter.conn);
    const rotated =
      both.every((o) => o.ok) &&
      !oldAfter.ok &&
      /WRONGPASS/.test(oldAfter.message ?? '') &&
      newAfter.ok &&
      (await works(live.conn));
    findings.push({
      check:
        'lifecycle: two passwords overlap (>new), then <old refuses new AUTHs with it while already-authenticated connections keep working',
      ok: rotated,
      observed: `overlap: old=${both[0].ok} new=${both[1].ok}; after <old: old=${oldAfter.ok ? 'accepted' : oldAfter.message} new=${newAfter.ok}; pre-rotation connection works=${await works(live.conn)}`,
    });

    // 2b. Rotation as ADR-0071 D4 does it: every re-assert is `reset` + the
    //     Secret's state, i.e. the new password plus the OLD one by its SHA-256
    //     (`#<hex>`), then, once retired, the new password alone.
    const third = randomBytes(24).toString('hex');
    const nextSha = createHash('sha256').update(next).digest('hex');
    const reassert = (extra) =>
      adminClient.call(
        'ACL',
        'SETUSER',
        c.username,
        ...aclRulesFor({ ...c, password: third, commands }),
        ...extra,
      );
    await reassert([`#${nextSha}`]);
    const hashed = [await open(next), await open(third)];
    for (const o of hashed) if (o.conn) conns.push(o.conn);
    await reassert([]);
    const hashedOldAfter = await open(next);
    const hashedNewAfter = await open(third);
    if (hashedNewAfter.conn) conns.push(hashedNewAfter.conn);
    const liveNext = hashed[0].conn;
    const reasserted =
      hashed.every((o) => o.ok) &&
      !hashedOldAfter.ok &&
      /WRONGPASS/.test(hashedOldAfter.message ?? '') &&
      hashedNewAfter.ok &&
      liveNext !== null &&
      (await works(liveNext));
    findings.push({
      check:
        're-assert with reset >new #sha256(old) accepts both; a re-assert with >new alone retires the old one, live connections unaffected',
      ok: reasserted,
      observed: `overlap: old=${hashed[0].ok} new=${hashed[1].ok}; after retire: old=${hashedOldAfter.ok ? 'accepted' : hashedOldAfter.message} new=${hashedNewAfter.ok}; overlap-time connection works=${liveNext !== null && (await works(liveNext))}`,
    });

    // 3. Deletion: what the finalizer does on app delete.
    await adminClient.call('ACL', 'DELUSER', c.username);
    await sleep(100);
    const afterDelete = await works(live.conn);
    findings.push({
      check: "lifecycle: ACL DELUSER disconnects the user's live connections",
      ok: !afterDelete,
      observed: afterDelete ? 'live connection still served' : 'live connection dropped',
    });
  } finally {
    for (const conn of conns) conn.disconnect();
    await adminClient.call('ACL', 'DELUSER', c.username).catch(() => {});
    await adminClient.call('DEL', `${c.prefix}:k`).catch(() => {});
  }
  return findings;
}

// ─── Driver ──────────────────────────────────────────────────────────────────

function unexpectedOf(matrix, handler) {
  const bad = matrix.filter((r) => r.kind !== 'observation' && r.outcome !== r.expect);
  return [
    ...bad.map(
      (r) =>
        `${r.kind} ${r.command} (${r.target}): expected ${r.expect}, got ${r.outcome}${r.message ? ` — ${r.message}` : ''}`,
    ),
    ...handler.filter((f) => !f.ok).map((f) => `handler: ${f.check} — ${f.observed}`),
  ];
}

function printTable(matrix, handler, meta) {
  const out = [];
  out.push(`# redis-acl-spike — runtime ${meta.runtime}, ${meta.redisVersion}`);
  out.push(`# rule set: ${meta.rules}`);
  out.push('');
  out.push('kind        target     expect  got     command                           origin');
  for (const r of matrix) {
    const mark = r.kind === 'observation' || r.outcome === r.expect ? ' ' : '!';
    out.push(
      `${mark}${r.kind.padEnd(11)}${r.target.padEnd(11)}${r.expect.padEnd(8)}${String(r.outcome).padEnd(8)}${r.command.slice(0, 33).padEnd(34)}${r.origin}${r.observed ? ` → ${r.observed}` : ''}`,
    );
  }
  if (handler.length > 0) {
    out.push('');
    out.push('real handler:');
    for (const f of handler) out.push(`${f.ok ? ' ok ' : ' !! '} ${f.check}: ${f.observed}`);
  }
  console.log(out.join('\n'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const admin = adminUrl();
  const Redis = requireFromCore('ioredis').default ?? requireFromCore('ioredis');
  const scripts = await import(pathToFileURL(join(ADAPTERS, 'use-cache-handler.js')).href);

  const adminClient = new Redis(admin.href, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  try {
    await adminClient.connect();
  } catch (err) {
    throw new Infrastructure(`cannot reach the admin URL: ${firstLine(err)}`);
  }
  const info = String(await adminClient.call('INFO', 'server'));
  // Valkey reports a frozen redis_version (7.2.4) for compatibility; name it.
  const valkey = /valkey_version:(\S+)/.exec(info)?.[1];
  const compat = /redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown';
  const redisVersion = valkey ? `valkey ${valkey} (redis_version ${compat})` : `redis ${compat}`;
  try {
    await adminClient.call('ACL', 'WHOAMI');
  } catch (err) {
    adminClient.disconnect();
    throw new Infrastructure(`this Redis has no ACL support (ACL WHOAMI: ${firstLine(err)})`);
  }

  const tag = randomBytes(4).toString('hex');
  const commands = [...MINIMAL_COMMANDS.filter((c) => !opts.drop.includes(c)), ...opts.grant];
  const a = {
    username: `knext-spike-a-${tag}`,
    prefix: `spike-a-${tag}`,
    password: randomBytes(24).toString('hex'),
  };
  const b = {
    username: `knext-spike-b-${tag}`,
    prefix: `spike-b-${tag}`,
    password: randomBytes(24).toString('hex'),
  };
  const cdnTagPrefix = randomBytes(6).toString('hex');
  const rules = aclRulesFor({ prefix: '<prefix>', password: '<redacted>', commands }).join(' ');

  let matrix = [];
  let handler = [];
  try {
    for (const u of [a, b]) {
      await adminClient.call('ACL', 'SETUSER', u.username, ...aclRulesFor({ ...u, commands }));
    }
    if (!opts.handlerOnly)
      matrix = await runMatrix({ Redis, admin, adminClient, a, b, scripts, cdnTagPrefix });
    if (!opts.matrixOnly) handler = await runRealHandler({ Redis, admin, a, b, cdnTagPrefix });
    if (!opts.matrixOnly && !opts.handlerOnly) {
      handler.push(...(await runLifecycle({ Redis, admin, adminClient, commands })));
    }
  } finally {
    // The spike's own throwaway users and keys — nothing else.
    for (const u of [a, b]) {
      await adminClient.call('ACL', 'DELUSER', u.username).catch(() => {});
      let cursor = '0';
      do {
        const [next, keys] = await adminClient.call(
          'SCAN',
          cursor,
          'MATCH',
          `${escapeAclGlob(u.prefix)}:*`,
          'COUNT',
          '1000',
        );
        cursor = next;
        if (keys.length > 0) await adminClient.call('DEL', ...keys);
      } while (cursor !== '0');
    }
    await adminClient.call('DEL', `knext:cdn:purged:${cdnTagPrefix}:b1`).catch(() => {});
    adminClient.disconnect();
  }

  const meta = { runtime: RUNTIME, redisVersion, rules };
  const unexpected = unexpectedOf(matrix, handler);
  if (opts.json) console.log(JSON.stringify({ ...meta, matrix, handler, unexpected }, null, 2));
  else printTable(matrix, handler, meta);
  if (unexpected.length > 0) {
    console.error(`\n${unexpected.length} unexpected outcome(s):\n  ${unexpected.join('\n  ')}`);
    if (opts.assert) return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      const kind =
        err instanceof UsageError
          ? 'usage'
          : err instanceof Infrastructure
            ? 'infrastructure'
            : 'crash';
      console.error(`redis-acl-spike: ${kind}: ${err?.message ?? err}`);
      // Never 1: that code means "the rule set is wrong", and a crash is not a finding.
      process.exit(err instanceof UsageError ? 2 : 3);
    });
}
