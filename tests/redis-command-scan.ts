/**
 * A source scan for the Redis commands a file can issue — the half of the
 * per-app Redis ACL check (tests/redis-acl-spike.test.ts) that runs without a
 * Redis. It over-approximates on purpose: a false hit is a red test someone has
 * to explain, a missed command is a NOPERM in production.
 *
 * What counts as issuing a command, for ANY receiver (no receiver names):
 *
 *   1. `<anything>.<m>(` where `m`, lowercased, is a Redis command in the
 *      canonical list (scripts/redis-commands.mjs: `COMMAND LIST` on Redis 7.4
 *      and Valkey 8.1). `conn.expire(…)`, `tx.unlink(…)`, `this.keys()` all
 *      count; `Map#get` counts as `get` too, which is harmless because `get` is
 *      granted.
 *   2. The generic issuers `.call(`, `.pcall(`, `.send(`, `.sendCommand(`
 *      (ioredis, Lua's `redis.call`, Bun's native client, node-redis): the FIRST
 *      argument is the command.
 *   3. The command helpers `command(`, `redisCommand(` (bare or as a method):
 *      `(client, '<CMD>', …)` — the SECOND argument is the command.
 *   4. A command tuple: an array literal whose first element is a quoted Redis
 *      command name, any case and any quote (`['SET', key, …]`), as fed to the
 *      MULTI/EXEC and pipeline forwarders.
 *
 * A command argument that is not a plain string literal — an identifier, an
 * expression, a template with `${…}` — cannot be resolved here, and is reported
 * as UNPARSEABLE. So is a computed method call (`tx[name](…)`), which can
 * dispatch any command. Unparseable is a failure in the test, not a pass; the
 * only way past it is an exact, justified entry in the test's forwarder list.
 */
import { REDIS_COMMANDS } from '../scripts/redis-commands.mjs';

export const REDIS_COMMAND_SET: ReadonlySet<string> = new Set(REDIS_COMMANDS);

const GENERIC_ISSUERS = new Set(['call', 'pcall', 'send', 'sendcommand']);
const HELPERS = new Set(['command', 'rediscommand']);

export type Hit = {
  /** The Redis command, lowercased. */
  command: string;
  /** Which rule found it (numbered as in the header). */
  via: 'method' | 'issuer' | 'helper' | 'tuple';
  /** `receiver.method` or the helper name, for explaining a hit. */
  site: string;
  line: number;
};

export type Unparseable = { line: number; text: string; why: string };

export type ScanResult = { hits: Hit[]; unparseable: Unparseable[] };

/** The 1-based line of a source offset. */
function lineOf(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function lineText(src: string, line: number): string {
  return (src.split('\n')[line - 1] ?? '').trim();
}

/** Split the top-level arguments that start at `open` (just after `(`), up to `max` of them. */
function leadingArgs(src: string, open: number, max: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = open;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        args.push(src.slice(start, i).trim());
        return args;
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      args.push(src.slice(start, i).trim());
      if (args.length >= max) return args;
      start = i + 1;
    }
  }
  return args;
}

/**
 * The command a string-literal argument names, or null when it is not a plain
 * literal. An array literal (`sendCommand(['SET', k, v])`, node-redis) names
 * the command in its first element.
 */
function literalCommand(arg: string | undefined): string | null {
  if (arg === undefined) return null;
  const inner = /^\[\s*([^,\]]*)/.exec(arg);
  if (inner) return literalCommand(inner[1].trim());
  const m = /^(['"`])([^'"`\\$]*)\1$/.exec(arg);
  if (!m) return null;
  const word = m[2].trim().split(/\s+/)[0] ?? '';
  return word === '' ? null : word.toLowerCase();
}

export function scanRedisCommands(src: string): ScanResult {
  const hits: Hit[] = [];
  const unparseable: Unparseable[] = [];
  const bad = (offset: number, why: string) => {
    const line = lineOf(src, offset);
    unparseable.push({ line, text: lineText(src, line), why });
  };

  // 1–3: named calls, as a method (`x.m(`, `x?.m(`) or bare (`m(`).
  for (const m of src.matchAll(/(?:([\w$\])]+)\s*\??\.\s*)?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const receiver = m[1];
    const name = m[2];
    const lower = name.toLowerCase();
    const open = (m.index ?? 0) + m[0].length;
    const site = receiver ? `${receiver}.${name}` : name;
    if (receiver && GENERIC_ISSUERS.has(lower)) {
      const [first] = leadingArgs(src, open, 1);
      const cmd = literalCommand(first);
      if (cmd === null) bad(m.index ?? 0, `${site}(…) with a non-literal command`);
      else hits.push({ command: cmd, via: 'issuer', site, line: lineOf(src, m.index ?? 0) });
      continue;
    }
    if (HELPERS.has(lower)) {
      const args = leadingArgs(src, open, 2);
      // `x.command('INFO')` is ioredis's COMMAND-style call with the command first;
      // `command(client, 'HSET', …)` is a helper with the command second.
      const cmd = literalCommand(args[0]) ?? literalCommand(args[1]);
      if (cmd === null) {
        // A declaration (`function redisCommand(client, name, args) {`) is not a call.
        const before = src.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
        if (/\bfunction\s*$/.test(before)) continue;
        bad(m.index ?? 0, `${site}(…) with a non-literal command`);
      } else hits.push({ command: cmd, via: 'helper', site, line: lineOf(src, m.index ?? 0) });
      continue;
    }
    if (receiver && REDIS_COMMAND_SET.has(lower)) {
      hits.push({ command: lower, via: 'method', site, line: lineOf(src, m.index ?? 0) });
    }
  }

  // 4: command tuples, any case, any quote.
  for (const m of src.matchAll(/\[\s*(['"`])([A-Za-z][A-Za-z_]*)\1\s*,/g)) {
    const cmd = m[2].toLowerCase();
    if (REDIS_COMMAND_SET.has(cmd)) {
      hits.push({
        command: cmd,
        via: 'tuple',
        site: `[${m[2]}, …]`,
        line: lineOf(src, m.index ?? 0),
      });
    }
  }

  // Computed method calls can dispatch any command.
  for (const m of src.matchAll(/[\w$\])]\s*\[[^\]\n]+\]\s*\(/g)) {
    bad(m.index ?? 0, 'computed method call');
  }

  return { hits, unparseable };
}
