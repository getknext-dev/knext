/**
 * A source scan for the Redis commands a file can issue — the half of the
 * per-app Redis ACL check (tests/redis-acl-spike.test.ts) that runs without a
 * Redis. It over-approximates on purpose: a false hit is a red test someone has
 * to explain, a missed command is a NOPERM in production. Where it cannot tell
 * which command a construct sends, it reports UNPARSEABLE, which the test treats
 * as a failure, never as a pass.
 *
 * A "command name" is a name in the canonical list (scripts/redis-commands.mjs:
 * `COMMAND LIST` on Redis 7.4 and Valkey 8.1), compared lowercased, or such a
 * name followed by ioredis's `Buffer` / `Stream` suffix (`unlinkBuffer`,
 * `zscanStream`), which sends the same command. What counts as issuing one, for
 * ANY receiver (no receiver names):
 *
 *   1. method — a member named like a command, `<anything>.<m>` or `?.<m>`, in a
 *      position that can invoke it: a call `(`, an optional call `?.(`, a
 *      `.bind(` / `.call(` / `.apply(` on it, the first argument of
 *      `Reflect.apply(`, or the whole right-hand side of an assignment
 *      (`const f = client.unlink;`). `conn.expire(…)`, `tx.unlink(…)`,
 *      `client.unlink?.(…)`, `client.unlink.bind(client)` all count; `Map#get`
 *      counts as `get` too, which is harmless because `get` is granted.
 *   2. issuer — `.call(`, `.pcall(`, `.send(`, `.sendCommand(`, `.callBuffer(`
 *      (ioredis, Lua's `redis.call`, Bun's native client, node-redis): the FIRST
 *      argument is the command.
 *   3. helper — `command(`, `redisCommand(`, any case, bare, as a method or
 *      after `new` (ioredis's `new Redis.Command('UNLINK', …)`): the FIRST
 *      argument when it is a literal (`x.command('INFO')`, `new Command(…)`),
 *      else the SECOND (`command(client, '<CMD>', …)`).
 *   4. tuple — an array literal whose first element is a quoted command name,
 *      any case and any quote (`['SET', key, …]`), as fed to the MULTI/EXEC and
 *      pipeline forwarders.
 *   5. destructure — an object pattern assigned from something
 *      (`const { unlink } = client`, `({ unlink: u } = client)`, with or without
 *      a TypeScript annotation): every key named like a command.
 *   6. reflect — `Reflect.get(x, '<cmd>')`, and a string-literal computed member
 *      (`client['unlink'](…)`).
 *
 * UNPARSEABLE (reported, never resolved to a pass): an issuer or helper whose
 * command argument is not a plain string literal (an identifier, an expression,
 * a template with `${…}`); a computed member `x[expr]` that is called, optionally
 * called, or bound / called / applied; a computed key in an object pattern;
 * `Reflect.get(x, <non-literal>)`; `Reflect.apply(<anything but a member>, …)`;
 * and a generic issuer that is referenced rather than called
 * (`client.call.bind(client)`), which can send anything.
 *
 * TWO EXCLUSIONS, each tested on both sides: a receiver in GLOBAL_RECEIVERS
 * (`Object.keys`, `console.info`: language globals, never a client), and a
 * call that passes no Redis argument (nothing, or only function literals) to a
 * command that needs one (`map.keys()`, `rows.sort((a, b) => a - b)`). Redis
 * checks arity before ACL (measured, Redis 7.4 and Valkey 8.1: `KEYS` with no
 * argument is `wrong number of arguments` for a user without `+keys`), so such
 * a call can never be a NOPERM. REDIS_NO_ARG_COMMANDS lists the commands that
 * DO take no argument (`client.info()`, `client.reset()` still count).
 *
 * WHAT IT DOES NOT SEE (stated, not hidden): a command method passed as an
 * argument (other than `Reflect.apply`'s first), stored in an array element, an
 * object-literal value or a default parameter, or read into a variable in any
 * position but the whole right-hand side of an assignment; a computed member
 * read into a variable and invoked later (`const f = client[name]; f()`);
 * nested destructuring (`const { a: { unlink } } = x`); a destructuring
 * PARAMETER (`function f({ unlink })`); `with`, `eval`, `new Function`, and a
 * Proxy over the client. Strings and comments are scanned like code, on purpose
 * (Lua lives in strings), so they can produce false hits but never hide one.
 */
import { REDIS_COMMANDS, REDIS_NO_ARG_COMMANDS } from '../scripts/redis-commands.mjs';

export const REDIS_COMMAND_SET: ReadonlySet<string> = new Set(REDIS_COMMANDS);
const NO_ARG: ReadonlySet<string> = new Set(REDIS_NO_ARG_COMMANDS);

const GENERIC_ISSUERS = new Set(['call', 'pcall', 'send', 'sendcommand', 'callbuffer']);
const HELPERS = new Set(['command', 'rediscommand']);

/**
 * Receivers that are ECMAScript or host globals (`Object.keys`, `console.info`,
 * `new WebAssembly.Module`), never a Redis client. A closed list of language
 * names, not an allowlist of sites: the test asserts each is a real global.
 */
export const GLOBAL_RECEIVERS: ReadonlySet<string> = new Set([
  'Array',
  'Atomics',
  'JSON',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Reflect',
  'String',
  'Symbol',
  'WebAssembly',
  'console',
]);

/** An argument that cannot be a Redis argument: a function literal (a comparator, a callback). */
const FUNCTION_LITERAL = /^(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)/;

/**
 * Does the call at `open` pass no Redis argument at all — nothing, or only
 * function literals (ioredis's trailing callback, a sort comparator)? Redis
 * answers such a call `wrong number of arguments` before its ACL check
 * (measured, both engines), unless the command takes no argument.
 */
function passesNoRedisArgument(src: string, open: number): boolean {
  const args = leadingArgs(src, open, 64);
  return args.every((a) => a === '' || FUNCTION_LITERAL.test(a));
}

/**
 * The command a method or property name sends, or null. `unlinkBuffer` and
 * `zscanStream` are ioredis's buffer-reply and streaming variants of `unlink`
 * and `zscan`: same command on the wire.
 */
export function commandOfName(name: string): string | null {
  const lower = name.toLowerCase();
  if (REDIS_COMMAND_SET.has(lower)) return lower;
  const stem = /^(.+?)(?:buffer|stream)$/.exec(lower)?.[1];
  return stem !== undefined && REDIS_COMMAND_SET.has(stem) ? stem : null;
}

export type Hit = {
  /** The Redis command, lowercased. */
  command: string;
  /** Which rule found it (numbered as in the header). */
  via: 'method' | 'issuer' | 'helper' | 'tuple' | 'destructure' | 'reflect';
  /** `receiver.method`, the helper name, or the pattern, for explaining a hit. */
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

/** The text of a plain string literal (no `${…}`), or null. */
function stringLiteral(arg: string | undefined): string | null {
  if (arg === undefined) return null;
  const m = /^(['"`])([^'"`\\$]*)\1$/.exec(arg.trim());
  return m ? m[2] : null;
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
  const text = stringLiteral(arg);
  if (text === null) return null;
  const word = text.trim().split(/\s+/)[0] ?? '';
  return word === '' ? null : word.toLowerCase();
}

/** Can what follows a member reference at `after` invoke it? */
function invokes(src: string, after: number, before: string): boolean {
  const rest = src.slice(after, after + 16);
  if (/^\s*(?:\?\.\s*)?\(/.test(rest)) return true; // call, optional call
  if (/^\s*\??\.\s*(?:bind|call|apply)\s*\(/.test(rest)) return true; // bound / forwarded
  if (/Reflect\s*\.\s*apply\s*\(\s*$/.test(before)) return true; // Reflect.apply(<this>, …)
  // The whole right-hand side of an assignment: `const f = client.unlink;`.
  return /(?:^|[^=!<>])=\s*$/.test(before) && /^\s*(?:;|,|\n|\)|$)/.test(rest);
}

export function scanRedisCommands(src: string): ScanResult {
  const hits: Hit[] = [];
  const unparseable: Unparseable[] = [];
  const at = (offset: number) => lineOf(src, offset);
  const bad = (offset: number, why: string) => {
    const line = lineOf(src, offset);
    unparseable.push({ line, text: lineText(src, line), why });
  };

  // 1–3: named members, as a method (`x.m`, `x?.m`) or bare (`m(`).
  for (const m of src.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) {
    const name = m[0];
    const lower = name.toLowerCase();
    const start = m.index ?? 0;
    const after = start + name.length;
    const before = src.slice(Math.max(0, start - 60), start);
    // The receiver, when this is a member (`x.m`, `x?.m`, `f().m`, multi-line chains).
    const member = /([\w$\])]+)\s*\??\.\s*$/.exec(before);
    if (!member && /\.\s*$/.test(before)) continue; // `...spread`, `1.5`: not a member
    const receiver = member?.[1];
    // What precedes the whole member expression (`Reflect.apply(`, `= `).
    const lead = member ? before.slice(0, member.index) : before;
    const called = /^\s*(?:\?\.\s*)?\(/.exec(src.slice(after, after + 8));
    const open = called ? after + called[0].length : -1;
    const site = receiver ? `${receiver}.${name}` : name;
    if (receiver && GENERIC_ISSUERS.has(lower)) {
      if (!called) {
        // `client.call.bind(client)`: a generic issuer handed on can send anything.
        if (invokes(src, after, lead))
          bad(start, `${site} referenced, not called: it can send any command`);
        continue;
      }
      const [first] = leadingArgs(src, open, 1);
      // `fn.call(this, …)` is Function.prototype.call: `this` names no command.
      if (lower === 'call' && first === 'this') continue;
      const cmd = literalCommand(first);
      if (cmd === null) bad(start, `${site}(…) with a non-literal command`);
      else hits.push({ command: cmd, via: 'issuer', site, line: at(start) });
      continue;
    }
    if (called && HELPERS.has(lower)) {
      const args = leadingArgs(src, open, 2);
      // `x.command('INFO')` is ioredis's COMMAND-style call with the command first;
      // `command(client, 'HSET', …)` is a helper with the command second.
      const cmd = literalCommand(args[0]) ?? literalCommand(args[1]);
      if (cmd === null) {
        // A declaration (`function redisCommand(client, name, args) {`) is not a call.
        if (/\bfunction\s*$/.test(before)) continue;
        bad(start, `${site}(…) with a non-literal command`);
      } else hits.push({ command: cmd, via: 'helper', site, line: at(start) });
      continue;
    }
    if (!receiver || GLOBAL_RECEIVERS.has(receiver)) continue;
    const cmd = commandOfName(name);
    if (cmd === null) continue;
    if (called && !NO_ARG.has(cmd) && passesNoRedisArgument(src, open)) continue;
    if (invokes(src, after, lead)) {
      hits.push({ command: cmd, via: 'method', site, line: at(start) });
    }
  }

  // 4: command tuples, any case, any quote.
  for (const m of src.matchAll(/\[\s*(['"`])([A-Za-z][A-Za-z_]*)\1\s*,/g)) {
    const cmd = m[2].toLowerCase();
    if (REDIS_COMMAND_SET.has(cmd)) {
      hits.push({ command: cmd, via: 'tuple', site: `[${m[2]}, …]`, line: at(m.index ?? 0) });
    }
  }

  // 5: object patterns assigned from something: `{ a, b: c, ...r } = x`,
  // `{ a }: T = x`. Not `==`, `===` or `=>`.
  for (const m of src.matchAll(/\{([^{}]*)\}\s*(?::\s*[^=;{}\n]+)?=(?![=>])\s*([\w$]*)/g)) {
    // `const { keys } = Object`: a language global, never a client.
    if (
      GLOBAL_RECEIVERS.has(m[2]) &&
      /^\s*(?:;|\n|$)/.test(src.slice((m.index ?? 0) + m[0].length))
    )
      continue;
    for (const raw of m[1].split(',')) {
      const element = raw.trim().replace(/^\.\.\./, '');
      if (element === '') continue;
      if (element.startsWith('[')) {
        bad(m.index ?? 0, 'computed key in a destructuring pattern');
        continue;
      }
      const key = /^([A-Za-z_$][\w$]*)|^(['"])([^'"]*)\2/.exec(element);
      const name = key?.[1] ?? key?.[3];
      const cmd = name === undefined ? null : commandOfName(name);
      if (cmd !== null) {
        hits.push({
          command: cmd,
          via: 'destructure',
          site: `{ ${name} } =`,
          line: at(m.index ?? 0),
        });
      }
    }
  }

  // 6: Reflect.get / Reflect.apply.
  for (const m of src.matchAll(/\bReflect\s*\.\s*(get|apply)\s*\(/g)) {
    const args = leadingArgs(src, (m.index ?? 0) + m[0].length, 2);
    if (m[1] === 'get') {
      const name = stringLiteral(args[1]);
      if (name === null) bad(m.index ?? 0, 'Reflect.get with a non-literal property');
      else {
        const cmd = commandOfName(name);
        if (cmd !== null)
          hits.push({ command: cmd, via: 'reflect', site: 'Reflect.get', line: at(m.index ?? 0) });
      }
    } else if (!/^[\w$\])]+\s*\??\.\s*[A-Za-z_$][\w$]*$/.test(args[0] ?? '')) {
      // A member target is resolved by rule 1; anything else could be any method.
      bad(m.index ?? 0, 'Reflect.apply on a target that is not a named member');
    }
  }

  // 7: computed members that are invoked: `x[e](`, `x?.[e](`, `x[e]?.(`,
  // `x[e].bind(` / `.call(` / `.apply(`. A string-literal key resolves.
  for (const m of src.matchAll(
    /[\w$\])]\s*(?:\?\.)?\s*\[([^\]\n]+)\]\s*(?:(?:\?\.)?\s*\(|\??\.\s*(?:bind|call|apply)\s*\()/g,
  )) {
    const key = stringLiteral(m[1]);
    if (key === null) {
      bad(m.index ?? 0, 'computed method call');
      continue;
    }
    const cmd = commandOfName(key);
    if (cmd !== null)
      hits.push({ command: cmd, via: 'reflect', site: `[${m[1].trim()}]`, line: at(m.index ?? 0) });
  }

  return { hits, unparseable };
}
