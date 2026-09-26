import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { REPO_ROOT, readManifest, workspaceManifests } from './helpers/workspace-manifests';

/**
 * #1402 — every workspace `typecheck` script that runs the TypeScript
 * compiler runs the `typescript-tsc7` alias, never the plain `typescript`
 * package (still installed at 5.9.x, so a regression fails nothing loudly —
 * it just typechecks on the slow binary).
 *
 * Reading `scripts.typecheck` as a string is not enough: a turbo task, a
 * `bun run tc`, a shell script or `echo skipped` all hide what actually runs.
 * So this guard RESOLVES THE SCRIPT CHAIN by CLASSIFYING EACH COMMAND by its
 * program, not by matching spellings:
 *
 *  - wrappers are peeled first: env assignments, `bunx`/`npx`/`pnpx`/`exec`/
 *    `env`, and `bun x`/`pnpm exec`/`pnpm dlx`/`npm exec`/`yarn exec`;
 *  - program `turbo` (with or without `run`): EVERY task token it names is
 *    followed into every manifest declaring it, narrowed by `--filter`;
 *  - program `bun`/`npm`/`pnpm`/`yarn`: runner flags are parsed (`--bun`,
 *    `--prefix <dir>`, `--cwd`, `-C`, `--filter`, `--workspace`, `-r`), and the
 *    named script (`run X` or shorthand `X`) is followed in the TARGETED
 *    manifest(s);
 *  - `sh|bash <file>` / `./x.sh` follow the file and classify its lines;
 *  - UNRESOLVED (red, fail closed): any runner/turbo command the parser cannot
 *    resolve, `sh -c`, `node -e|--eval|-p|--print`, a program that is a
 *    `$VAR`/`$(…)`/backtick expansion, a missing script/file/manifest, and ANY
 *    OTHER PROGRAM (`make`, `node x.mjs`, `python3`, `deno`, …) that is neither a
 *    compiler entry nor on the small non-compiler allowlist (`echo`, `true`,
 *    `test`/`[`, `node --check`; plus the shell builtins `set`/`exit`/`return`,
 *    which the classifier models itself);
 *  - commands are split the way sh splits them: separators inside single/double quotes,
 *    after a backslash, inside `$(…)`/backticks, or in a `#` comment are not separators;
 *    plain tsc inside a `$(…)`/backtick substitution is still caught;
 *  - SHELL CONTROL STRUCTURES FAIL CLOSED: `if`/`then`/`fi`, `for`/`while`/`do`/`done`,
 *    `case`, `(…)` subshells and `{…}` groups are not modelled, so their keywords are
 *    classified as unknown (or dynamic) programs and go red. Write the typecheck as a flat
 *    command list instead;
 *  - everything after an `exit`/`return` is masked. A command's exit code is enforced only
 *    when its statement is the LAST one, or when `set -e` is in effect for it and it ends
 *    its and-or list (sh ignores errexit for a non-final `&&` operand). `set -e`/`set +e`
 *    are tracked PER STATEMENT, in package scripts and shell files alike: `set -e` counts
 *    only as the unconditional first command of a statement; `set +e` anywhere turns it
 *    off.
 *  - `cmd || exit_code=$?` (capture-then-report) is REJECTED by the `||` rule even if the
 *    script later exits with `$exit_code` — the guard does not track variables. The
 *    accepted equivalent is to let errexit fail the script: `set -e` on an earlier
 *    statement, then the tsc7 run as its own statement.
 *
 * Rules:
 *  - no command in any chain may invoke plain tsc: a bare `tsc` token, a
 *    `.bin/tsc`, or anything under the `typescript/` package's `bin/` or
 *    `lib/` (e.g. `node node_modules/typescript/lib/_tsc.js`);
 *  - the known tsc7 consumers' chains MUST reach an ENFORCED typecheck: a
 *    typescript-tsc7 invocation carrying `-p`/`--project`/`--noEmit`/`-b`/`--build`
 *    (not `--version`/`--help`/`-?`/`--noCheck`/`--watch`/`--clean`/`--dry`/`-b -d`; all
 *    matched case-insensitively), whose exit code is not masked — not behind `||`, not
 *    followed by `||`/`|`/`&`, not followed by `;`/newline unless errexit is in effect, and
 *    not inside a masked hop;
 *  - scripts that never run a compiler (`packages/kn-next-alias`'s
 *    `node --check`) are otherwise unaffected.
 */

type Scripts = Record<string, string>;
interface Pkg {
  path: string;
  scripts: Scripts;
  name?: string;
}

const KNOWN_TSC7_CONSUMERS = [
  'package.json',
  'packages/lib/package.json',
  'packages/db/package.json',
  'packages/kn-next/package.json',
  'packages/ui/package.json',
  'apps/db-demo/package.json',
  'apps/file-manager/package.json',
];

const TSC7_BIN = /(^|\/)typescript-tsc7\/(bin\/tsc|lib\/_?tsc\.js)$/;
const PLAIN_TS_PKG = /(^|\/)typescript\/(bin|lib)\//;
const TSC_LIKE = /(^|\/)(tsc|_?tsc\.js)$/;
const TYPECHECK_FLAG = /^(-p|--project|--noEmit|-b|--build)(=.*)?$/i;
/**
 * Flags that make a tsc7 run NOT an enforced typecheck: info-only runs (incl. `-?`),
 * `--noCheck` (TS 7.0.2 exits 0 on a type error), `--watch` (never exits on errors),
 * `-b --clean` (deletes outputs, checks nothing) and `-b --dry` / `-b -d` (exits 0 on a type
 * error). Matched case-INSENSITIVELY, as tsc parses them (`--NOCHECK`, `--Version` work).
 */
const DISQUALIFYING_FLAG =
  /^(-v|--version|-h|--help|-\?|--all|--init|--showConfig|--listFilesOnly|--noCheck(=.*)?|-w|--watch(=.*)?|--clean|--dry)$/i;
const BUILD_FLAG = /^(-b|--build)$/i;
/** Programs known NOT to be compilers. Anything else that is not a tsc7 entry fails closed. */
const NON_COMPILERS = new Set(['echo', 'true', 'test', '[']);
/** Shell builtins whose effect the classifier models itself (`set -e`, `exit`/`return` masking). */
const SHELL_CONTROL = new Set(['set', 'exit', 'return']);
const EXITS = new Set(['exit', 'return']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DYNAMIC = /^[$`({]|\$\(/;
const RUNNERS = new Set(['bun', 'npm', 'pnpm', 'yarn']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const EXEC_WRAPPERS = new Set(['bunx', 'npx', 'pnpx', 'exec', 'env', 'command', 'time', 'nice']);
const RUNNER_EXEC_VERBS = new Set(['x', 'exec', 'dlx']);
/** Flags whose value is the NEXT token (unless written `--flag=value`). */
const VALUE_FLAGS = new Set([
  '--prefix',
  '-C',
  '--dir',
  '--cwd',
  '--filter',
  '-F',
  '--workspace',
  '--package',
  '--concurrency',
  '--cache-dir',
  '--output-logs',
  '--log-order',
  '--env-mode',
]);
const CWD_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd']);
const FILTER_FLAGS = new Set(['--filter', '-F', '--workspace']);
const ALL_FLAGS = new Set(['--workspaces', '-ws', '--recursive']);

interface Cmd {
  /** Raw source text of the command (for messages). */
  text: string;
  /** Words after quote removal; a `$(…)`/backtick substitution stays inside its word verbatim. */
  tokens: string[];
  /** Bodies of the command substitutions (`$(…)`, backticks) the command contains. */
  subs: string[];
  /** The separator that ends the command (undefined at end of input). */
  sep?: string;
}

/** Index of the `)` closing the `(` at `open` (quote- and escape-aware); end of input if none. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === "'") {
      const e = s.indexOf("'", j + 1);
      j = e < 0 ? s.length : e;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return s.length;
}

/** Index of the backtick closing the one at `open` (escape-aware); end of input if none. */
function closeTick(s: string, open: number): number {
  for (let j = open + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '`') return j;
  }
  return s.length;
}

/**
 * Split a shell command list into commands, the way sh does: separators (`&&`, `||`, `;`,
 * `|`, `|&`, `&` — not the `&` of `2>&1`/`&>` — and newline) count only OUTSIDE single/double
 * quotes, backslash escapes and command substitutions; `#` at the start of a word outside
 * quotes starts a comment to end of line; backslash-newline continues the line, and a newline
 * right after `&&`/`||`/`|` continues the list.
 */
function lex(s: string): Cmd[] {
  const cmds: Cmd[] = [];
  let tokens: string[] = [];
  let subs: string[] = [];
  let word = '';
  let inWord = false;
  let start = 0;
  let i = 0;
  const endWord = () => {
    if (inWord) tokens.push(word);
    word = '';
    inWord = false;
  };
  const endCmd = (sep: string | undefined, width: number) => {
    endWord();
    const prev = cmds[cmds.length - 1];
    const continuation =
      sep === '\n' &&
      tokens.length === 0 &&
      prev !== undefined &&
      /^(&&|\|\||\|)$/.test(prev.sep ?? '');
    if (!continuation) cmds.push({ text: s.slice(start, i).trim(), tokens, subs, sep });
    tokens = [];
    subs = [];
    i += width;
    start = i;
  };
  const substitution = (open: number): number => {
    const tick = s[open] === '`';
    const end = tick ? closeTick(s, open) : closeParen(s, open + 1);
    subs.push(s.slice(open + (tick ? 1 : 2), end));
    word += s.slice(open, end + 1);
    return end + 1;
  };
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '\\') {
      if (n !== '\n' && n !== undefined) word += n;
      inWord = inWord || n !== '\n';
      i += 2;
    } else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      const stop = e < 0 ? s.length : e;
      word += s.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
    } else if (c === '"') {
      inWord = true;
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && '"\\$`\n'.includes(s[j + 1] ?? 'x')) {
          if (s[j + 1] !== '\n') word += s[j + 1];
          j += 2;
        } else if ((s[j] === '$' && s[j + 1] === '(') || s[j] === '`') j = substitution(j);
        else word += s[j++];
      }
      i = j + 1;
    } else if ((c === '$' && n === '(') || c === '`') {
      inWord = true;
      i = substitution(i);
    } else if (c === '#' && !inWord) {
      const e = s.indexOf('\n', i);
      i = e < 0 ? s.length : e;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '\n' || c === ';') endCmd(c, 1);
    else if (c === '&' && n === '&') endCmd('&&', 2);
    else if (c === '&' && n !== '>' && s[i - 1] !== '>' && s[i - 1] !== '<') endCmd('&', 1);
    else if (c === '|' && n === '|') endCmd('||', 2);
    else if (c === '|') endCmd('|', n === '&' ? 2 : 1);
    else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endCmd(undefined, 0);
  return cmds;
}

interface Segment {
  text: string;
  tokens: string[];
  subs: string[];
  /** The shell would not propagate this command's exit code (or may not run it). */
  masked: boolean;
}

const firstProgram = (tokens: string[]) => tokens.find((t) => !ENV_ASSIGN.test(t));
const TERMINATORS = new Set([undefined, ';', '\n', '&']);

/** The errexit effect of a `set` command's arguments, in order: true (on), false (off), or undefined. */
function errexitEffect(args: string[]): boolean | undefined {
  let effect: boolean | undefined;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (/^[-+]o$/.test(a) && args[j + 1] === 'errexit') effect = a === '-o';
    else if (/^-[A-Za-z]*e/.test(a)) effect = true;
    else if (/^\+[A-Za-z]*e/.test(a)) effect = false;
  }
  return effect;
}

/**
 * Split a command list into commands and mark the masked ones (exit code not propagated).
 * A command's failure fails the list only when: it is not behind or followed by `||` in its
 * and-or list, not piped into anything, not backgrounded, not after an `exit`/`return` — AND
 * either its statement is the LAST one (its status is the script's) or `set -e` is in effect
 * and the command ends its and-or list (sh ignores errexit for a non-final `&&` operand).
 * `set -e` is tracked PER STATEMENT: it turns errexit on only as the unconditional first
 * command of a statement (not piped, not backgrounded); `set +e` anywhere turns it off.
 */
function segments(script: string, inherited: boolean): Segment[] {
  const statements: Cmd[][] = [[]];
  for (const c of lex(script)) {
    statements[statements.length - 1].push(c);
    if (TERMINATORS.has(c.sep)) statements.push([]);
  }
  const live = statements.filter((st) => st.some((c) => c.tokens.length > 0));
  const out: Segment[] = [];
  let errexit = false;
  let exited = false;
  for (const [si, st] of live.entries()) {
    const term = st[st.length - 1].sep;
    const last = si === live.length - 1;
    for (const [k, c] of st.entries()) {
      const before = st.slice(0, k).map((x) => x.sep);
      const after = st.slice(k, -1).map((x) => x.sep);
      const pipedOut = k < st.length - 1 && c.sep === '|';
      const masked =
        inherited ||
        exited ||
        before.includes('||') ||
        after.includes('||') ||
        pipedOut ||
        term === '&' ||
        !(last || (errexit && !after.includes('&&')));
      const prog = firstProgram(c.tokens);
      if (prog === 'set') {
        const effect = errexitEffect(c.tokens.slice(c.tokens.indexOf('set') + 1));
        if (effect === false) errexit = false;
        else if (effect === true && k === 0 && !pipedOut && term !== '&') errexit = true;
      }
      out.push({ text: c.text, tokens: c.tokens, subs: c.subs, masked });
      if (prog !== undefined && EXITS.has(prog)) exited = true;
    }
  }
  return out;
}

/** Every token of a command substitution body, recursively (for the plain-tsc scan). */
function substitutionTokens(subs: string[]): string[] {
  return subs.flatMap((body) =>
    lex(body).flatMap((c) => [...c.tokens, ...substitutionTokens(c.subs)]),
  );
}

interface Chain {
  tsc7: number;
  plainTsc: string[];
  unresolved: string[];
}

interface ParsedFlags {
  cwd?: string;
  filters: string[];
  all: boolean;
  /** Non-flag arguments, in order. */
  rest: string[];
}

/** Parse runner/turbo flags anywhere before `--`; values of VALUE_FLAGS are consumed. */
function parseFlags(prog: string, args: string[]): ParsedFlags {
  const out: ParsedFlags = { filters: [], all: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-') {
      out.rest.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    // npm `-w <ws>` is a workspace; pnpm `-w` is the (valueless) workspace root.
    const takesValue = VALUE_FLAGS.has(name) || (prog === 'npm' && name === '-w');
    const value = eq > 0 ? a.slice(eq + 1) : takesValue ? args[++i] : undefined;
    if (CWD_FLAGS.has(name)) out.cwd = value;
    else if (FILTER_FLAGS.has(name) || (prog === 'npm' && name === '-w')) {
      if (value !== undefined) out.filters.push(value);
    } else if (ALL_FLAGS.has(name) || (prog === 'pnpm' && name === '-r')) out.all = true;
  }
  return out;
}

const pkgDir = (p: Pkg) => posix.dirname(p.path);

function globRe(glob: string): RegExp {
  const src = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${src}$`);
}

/** Packages a `--filter`/`--workspace` selects, or undefined when the syntax is not understood. */
function matchFilter(filter: string, from: Pkg, all: Pkg[]): Pkg[] | undefined {
  if (/\.\.\.|[\^![\]{}]/.test(filter)) return undefined;
  if (
    filter.startsWith('./') ||
    filter.startsWith('../') ||
    (filter.includes('/') && !filter.startsWith('@'))
  ) {
    const re = globRe(posix.normalize(posix.join(pkgDir(from), filter)).replace(/\/$/, ''));
    return all.filter((q) => re.test(pkgDir(q)));
  }
  const re = globRe(filter);
  return all.filter((q) => q.name !== undefined && re.test(q.name));
}

/**
 * Follow `start` (a script name in `pkg`) through every hop; classify every
 * command. `root` is the directory manifests' paths are relative to (for
 * `--prefix` targets and followed shell files).
 */
function resolveChain(pkg: Pkg, start: string, all: Pkg[], root = REPO_ROOT): Chain {
  const out: Chain = { tsc7: 0, plainTsc: [], unresolved: [] };
  const seen = new Set<string>();
  const universe = all.includes(pkg) ? all : [pkg, ...all];

  const visitScript = (p: Pkg, name: string, masked: boolean) => {
    const key = `${p.path}#${name}`;
    if (seen.has(`${key}|${masked}`)) return;
    seen.add(`${key}|${masked}`);
    const script = p.scripts[name];
    if (script === undefined) {
      out.unresolved.push(key);
      return;
    }
    runList(p, key, script, masked);
  };

  const runList = (p: Pkg, key: string, script: string, masked: boolean) => {
    for (const seg of segments(script, masked)) classify(p, key, seg);
  };

  const followFile = (p: Pkg, key: string, file: string, masked: boolean) => {
    const rel = posix.normalize(posix.join(pkgDir(p), file));
    const abs = resolve(root, rel);
    if (!existsSync(abs)) {
      out.unresolved.push(`${key}: shell file ${rel} not found`);
      return;
    }
    const seenKey = `${rel}|${masked}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    // the file is one command list: `segments` models comments, quoting and `set -e`
    runList(p, `${p.path}>${rel}`, readFileSync(abs, 'utf8'), masked);
  };

  /** Union of the packages `filters` select; undefined (and reported) if any is not understood or selects none. */
  const select = (p: Pkg, key: string, prog: string, filters: string[]): Pkg[] | undefined => {
    const picked = new Set<Pkg>();
    for (const f of filters) {
      const m = matchFilter(f, p, universe);
      if (m === undefined)
        out.unresolved.push(`${key}: ${prog} filter ${f}: syntax not understood`);
      else if (m.length === 0)
        out.unresolved.push(`${key}: ${prog} filter ${f} selects no package`);
      if (m === undefined || m.length === 0) return undefined;
      for (const q of m) picked.add(q);
    }
    return [...picked];
  };

  const turbo = (p: Pkg, key: string, args: string[], masked: boolean, text: string) => {
    const flags = parseFlags('turbo', args);
    const tasks = flags.rest[0] === 'run' ? flags.rest.slice(1) : flags.rest;
    if (tasks.length === 0) {
      out.unresolved.push(`${key}: turbo names no task: ${text}`);
      return;
    }
    const targets = flags.filters.length > 0 ? select(p, key, 'turbo', flags.filters) : universe;
    if (targets === undefined) return;
    for (const token of tasks) {
      let scoped = targets;
      let task = token;
      const hash = token.indexOf('#');
      if (hash >= 0) {
        const owner = token.slice(0, hash);
        task = token.slice(hash + 1);
        scoped = universe.filter((q) =>
          owner === '//' ? q.path === 'package.json' : q.name === owner,
        );
      }
      const declaring = scoped.filter((q) => q.scripts[task] !== undefined);
      if (declaring.length === 0)
        out.unresolved.push(`${key}: turbo task ${token} declared nowhere`);
      for (const q of declaring) visitScript(q, task, masked);
    }
  };

  const runner = (
    p: Pkg,
    key: string,
    prog: string,
    args: string[],
    masked: boolean,
    text: string,
  ) => {
    const flags = parseFlags(prog, args);
    let rest = flags.rest;
    if (prog === 'yarn' && rest[0] === 'workspace' && rest[1]) {
      flags.filters.push(rest[1]);
      rest = rest.slice(2);
    }
    if (rest[0] === 'run' || rest[0] === 'run-script') rest = rest.slice(1);
    const script = rest[0];
    if (script === undefined) {
      out.unresolved.push(`${key}: ${prog} names no script: ${text}`);
      return;
    }
    let targets: Pkg[];
    if (flags.all) targets = universe;
    else if (flags.filters.length > 0) {
      const picked = select(p, key, prog, flags.filters);
      if (picked === undefined) return;
      targets = picked;
    } else if (flags.cwd !== undefined) {
      const manifest = posix.normalize(posix.join(pkgDir(p), flags.cwd, 'package.json'));
      const q = universe.find((u) => u.path === manifest);
      if (q === undefined) {
        out.unresolved.push(`${key}: ${prog} targets ${manifest}, which is not a known manifest`);
        return;
      }
      targets = [q];
    } else targets = [p];
    const declaring = targets.filter((q) => q.scripts[script] !== undefined);
    if (declaring.length === 0) {
      // `bun <file>` runs the file: acceptable only when it IS a compiler entry.
      if (prog === 'bun' && TSC7_BIN.test(script))
        // the file's own arguments INCLUDING its flags (`rest` has the flags stripped)
        return compiler(key, script, args.slice(args.indexOf(script) + 1), masked, text);
      out.unresolved.push(`${key}: ${prog} ${script} is not a script of the targeted package(s)`);
      return;
    }
    for (const q of declaring) visitScript(q, script, masked);
  };

  /** A program that is not a runner/turbo/shell: a tsc7 entry, plain tsc, a known non-compiler — or unknown (red). */
  const compiler = (key: string, prog: string, args: string[], masked: boolean, text: string) => {
    if (TSC7_BIN.test(prog)) {
      // in build mode `-d` is `--dry` (outside it, `-d` is `--declaration`)
      const build = args.some((a) => BUILD_FLAG.test(a));
      const enforced =
        args.some((a) => TYPECHECK_FLAG.test(a)) &&
        !args.some((a) => DISQUALIFYING_FLAG.test(a) || (build && /^-d$/i.test(a)));
      if (enforced && !masked) out.tsc7++;
      return;
    }
    if (PLAIN_TS_PKG.test(prog) || TSC_LIKE.test(prog)) return; // already reported as plain tsc
    out.unresolved.push(`${key}: unknown program ${prog} (not a known non-compiler): ${text}`);
  };

  const classify = (p: Pkg, key: string, seg: Segment) => {
    const { tokens, masked } = seg;
    const text = seg.text.trim();
    if (tokens.length === 0) return;
    // plain-typescript references ANYWHERE in the command, including inside `$(…)`/backtick
    // substitutions (catches `_tsc.js`, `.bin/tsc`, `echo $(tsc -p .)`); reported once per command
    const plain = (t: string) => PLAIN_TS_PKG.test(t) || (TSC_LIKE.test(t) && !TSC7_BIN.test(t));
    if ([...tokens, ...substitutionTokens(seg.subs)].some(plain)) {
      out.plainTsc.push(`${key}: ${text}`);
    }
    let i = 0;
    let wrapped = false;
    for (;;) {
      while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) i++;
      if (i >= tokens.length) {
        // bare assignments run nothing; a wrapper with nothing after it fails closed
        if (wrapped) out.unresolved.push(`${key}: wrapper with no program: ${text}`);
        return;
      }
      const t = tokens[i];
      wrapped = true;
      if (EXEC_WRAPPERS.has(t)) {
        i++;
        while (i < tokens.length && tokens[i].startsWith('-')) {
          i += VALUE_FLAGS.has(tokens[i]) || tokens[i] === '-p' ? 2 : 1;
        }
        continue;
      }
      if (RUNNERS.has(t)) {
        const verb = parseFlags(t, tokens.slice(i + 1)).rest[0];
        if (verb !== undefined && RUNNER_EXEC_VERBS.has(verb)) {
          i = tokens.indexOf(verb, i + 1) + 1;
          while (i < tokens.length && tokens[i].startsWith('-')) i++;
          continue;
        }
      }
      break;
    }
    const prog = tokens[i];
    const args = tokens.slice(i + 1);
    const base = posix.basename(prog);
    if (DYNAMIC.test(prog) || prog.includes('`')) {
      out.unresolved.push(`${key}: dynamic program: ${text}`);
      return;
    }
    if (NON_COMPILERS.has(prog) || SHELL_CONTROL.has(prog)) return;
    if (base === 'turbo') return turbo(p, key, args, masked, text);
    if (RUNNERS.has(prog)) return runner(p, key, prog, args, masked, text);
    if (SHELLS.has(base)) {
      const flags: string[] = [];
      let j = 0;
      while (j < args.length && args[j].startsWith('-')) {
        flags.push(args[j]);
        j += /^[-+][a-z]*o$/.test(args[j]) ? 2 : 1; // `-o opt` / `-euo pipefail`
      }
      if (flags.some((f) => /^-[a-z]*c/.test(f)) || args[j] === undefined) {
        out.unresolved.push(`${key}: inline shell: ${text}`);
        return;
      }
      return followFile(p, key, args[j], masked);
    }
    if (prog.endsWith('.sh')) return followFile(p, key, prog, masked);
    if (base === 'node') {
      let j = 0;
      let check = false;
      while (j < args.length && args[j].startsWith('-')) {
        if (/^(-e|--eval|-p|--print)(=.*)?$/.test(args[j])) {
          out.unresolved.push(`${key}: node inline code: ${text}`);
          return;
        }
        if (args[j] === '--check' || args[j] === '-c') check = true;
        j += /^(-r|--require|--import)$/.test(args[j]) ? 2 : 1;
      }
      if (check) return; // `node --check <file>` only parses the file
      if (args[j] === undefined) {
        out.unresolved.push(`${key}: node runs no file: ${text}`);
        return;
      }
      return compiler(key, args[j], args.slice(j + 1), masked, text);
    }
    compiler(key, prog, args, masked, text);
  };

  visitScript(pkg, start, false);
  return out;
}

function allPackages(): Pkg[] {
  const manifests = [readManifest(resolve(REPO_ROOT, 'package.json')), ...workspaceManifests()];
  return manifests.map(({ path, pkg }) => ({
    path,
    name: typeof pkg.name === 'string' ? pkg.name : undefined,
    scripts: (pkg.scripts as Scripts | undefined) ?? {},
  }));
}
const PACKAGES = allPackages();
const WITH_TYPECHECK = PACKAGES.filter((p) => p.scripts.typecheck !== undefined);

describe('#1402 — typecheck script chains run typescript-tsc7, never plain tsc', () => {
  it('discovers every known tsc7 consumer (an over-narrowed scan fails here)', () => {
    const found = WITH_TYPECHECK.map((p) => p.path);
    for (const known of KNOWN_TSC7_CONSUMERS) {
      expect(found, `${known}'s typecheck script was not discovered`).toContain(known);
    }
  });

  it.each(
    WITH_TYPECHECK.map((p) => [p.path, p] as const),
  )('%s: the resolved typecheck chain never invokes plain tsc and resolves fully', (_path, pkg) => {
    const chain = resolveChain(pkg, 'typecheck', PACKAGES);
    expect(chain.unresolved, 'unresolvable script hop').toEqual([]);
    expect(chain.plainTsc, 'plain (5.9.x) tsc reached').toEqual([]);
  });

  it.each(
    KNOWN_TSC7_CONSUMERS,
  )('%s: the resolved typecheck chain invokes typescript-tsc7', (path) => {
    const pkg = PACKAGES.find((p) => p.path === path);
    expect(pkg, `${path} not found`).toBeDefined();
    const chain = resolveChain(pkg as Pkg, 'typecheck', PACKAGES);
    expect(
      chain.tsc7,
      `${path}'s typecheck never reaches a typescript-tsc7 invocation`,
    ).toBeGreaterThan(0);
  });
});

describe('#1402 — resolveChain self-test (each known bypass is caught)', () => {
  const pkg = (path: string, scripts: Scripts): Pkg => ({ path, scripts });
  const chainOf = (scripts: Scripts, others: Pkg[] = []) => {
    const root = pkg('root', scripts);
    return resolveChain(root, 'typecheck', [root, ...others]);
  };
  const TSC7 = '../../node_modules/typescript-tsc7/bin/tsc --noEmit';

  it('accepts the direct tsc7 invocation', () => {
    expect(chainOf({ typecheck: TSC7 })).toEqual({ tsc7: 1, plainTsc: [], unresolved: [] });
  });

  it('follows `bun run` / `npm run` / `bun <script>` hops', () => {
    expect(chainOf({ typecheck: 'bun run tc', tc: TSC7 }).tsc7).toBe(1);
    expect(chainOf({ typecheck: 'npm run tc', tc: TSC7 }).tsc7).toBe(1);
    expect(chainOf({ typecheck: 'bun tc', tc: TSC7 }).tsc7).toBe(1);
    expect(chainOf({ typecheck: 'bun run tc', tc: 'tsc --noEmit' }).plainTsc).toHaveLength(1);
  });

  it('follows `turbo run X` into every package declaring X', () => {
    const ws = pkg('packages/a/package.json', { 'typecheck:inner': 'tsc --noEmit' });
    expect(chainOf({ typecheck: 'turbo run typecheck:inner' }, [ws]).plainTsc).toHaveLength(1);
    const ok = pkg('packages/a/package.json', { 'typecheck:inner': TSC7 });
    expect(chainOf({ typecheck: 'turbo run typecheck:inner' }, [ok]).tsc7).toBe(1);
  });

  it('fails an unresolvable hop', () => {
    expect(chainOf({ typecheck: 'bun run nope' }).unresolved).toEqual([
      'root#typecheck: bun nope is not a script of the targeted package(s)',
    ]);
    expect(chainOf({ typecheck: 'turbo run nope' }).unresolved).toEqual([
      'root#typecheck: turbo task nope declared nowhere',
    ]);
    expect(chainOf({ other: TSC7 }).unresolved).toEqual(['root#typecheck']);
  });

  it('flags the plain typescript package bin/lib, including `_tsc.js`', () => {
    expect(
      chainOf({ typecheck: 'node node_modules/typescript/lib/_tsc.js' }).plainTsc,
    ).toHaveLength(1);
    expect(chainOf({ typecheck: 'node_modules/typescript/bin/tsc' }).plainTsc).toHaveLength(1);
    // under the plain package's lib/ even when the file is not named like tsc
    expect(
      chainOf({ typecheck: 'node node_modules/typescript/lib/typescript.js' }).plainTsc,
    ).toHaveLength(1);
    expect(chainOf({ typecheck: 'node_modules/.bin/tsc --noEmit' }).plainTsc).toHaveLength(1);
    expect(chainOf({ typecheck: 'node node_modules/typescript-tsc7/lib/_tsc.js -p .' }).tsc7).toBe(
      1,
    );
  });

  it('matches the executable token, not a substring (`tsc -p tsconfig.typescript-tsc7.json`)', () => {
    const c = chainOf({ typecheck: 'tsc -p tsconfig.typescript-tsc7.json' });
    expect(c.tsc7).toBe(0);
    expect(c.plainTsc).toHaveLength(1);
  });

  it('a non-compiler script reaches no tsc7 (so `echo skipped` fails for a known consumer)', () => {
    expect(chainOf({ typecheck: 'echo skipped' })).toEqual({
      tsc7: 0,
      plainTsc: [],
      unresolved: [],
    });
    expect(chainOf({ typecheck: 'node --check bin/kn-next.js' }).plainTsc).toEqual([]);
  });
});

describe('#1402 — runner/turbo commands are classified, never skipped', () => {
  const pkg = (path: string, scripts: Scripts, name?: string): Pkg => ({ path, scripts, name });
  const TSC7 = '../../node_modules/typescript-tsc7/bin/tsc --noEmit';
  const lib = (scripts: Scripts) => pkg('packages/lib/package.json', scripts, '@getknext/lib');
  const ui = (scripts: Scripts) => pkg('packages/ui/package.json', scripts, '@getknext/ui');
  const run = (l: Pkg, others: Pkg[] = []) => resolveChain(l, 'typecheck', [l, ...others]);
  const B = '../../node_modules/typescript-tsc7/bin/tsc -b';
  const PLAIN_UI = ui({ 'typecheck:x': 'tsc --noEmit', tc: 'tsc --noEmit' });

  it.each([
    ['turbo shorthand without `run`', `${TSC7} && turbo typecheck:x`],
    ['bunx turbo run', `${TSC7} && bunx turbo run typecheck:x`],
    ['npx turbo run', `${TSC7} && npx turbo run typecheck:x`],
    ['turbo run with several tasks (not only the first)', `${TSC7} && turbo run test typecheck:x`],
    ['turbo run with a --filter', `${TSC7} && turbo run typecheck:x --filter=@getknext/ui`],
    ['npm --prefix <dir> run', `${TSC7} && npm --prefix ../ui run tc`],
    ['pnpm --filter <name> run', `${TSC7} && pnpm --filter @getknext/ui run tc`],
    ['yarn workspace <name>', `${TSC7} && yarn workspace @getknext/ui tc`],
  ])('%s: follows into the plain-tsc target', (_label, typecheck) => {
    const c = run(lib({ typecheck, test: 'echo ok' }), [PLAIN_UI]);
    expect(c.unresolved).toEqual([]);
    expect(c.plainTsc.length).toBeGreaterThan(0);
  });

  it('turbo `<owner>#task` runs only the owner package', () => {
    const own = lib({ typecheck: 'turbo run @getknext/lib#tc', tc: TSC7 });
    const c = run(own, [PLAIN_UI]);
    expect(c).toEqual({ tsc7: 1, plainTsc: [], unresolved: [] });
  });

  it('bun --bun run follows the script in the same package', () => {
    const c = run(lib({ typecheck: `${TSC7} && bun --bun run tc`, tc: 'tsc --noEmit' }));
    expect(c.plainTsc).toHaveLength(1);
  });

  it.each([
    ['turbo task nobody declares', 'turbo typecheck:nope', 'declared nowhere'],
    [
      '--prefix to a directory with no manifest',
      'npm --prefix ../nowhere run tc',
      'not a known manifest',
    ],
    [
      '--filter matching no package',
      'turbo run typecheck:x --filter=@getknext/nope',
      'selects no package',
    ],
    [
      'a --filter with graph syntax',
      'turbo run typecheck:x --filter=...@getknext/ui',
      'syntax not understood',
    ],
    ['a runner verb that is not a script', 'bun scripts/tc.ts', 'is not a script'],
    ['sh -c', 'sh -c scripts/tc.sh', 'inline shell'],
    ['sh of a missing file', 'sh scripts/does-not-exist.sh', 'not found'],
    ['bash -c', 'bash -euo pipefail -c true', 'inline shell'],
    ['node -e', `node -e "require('typescript/lib/tsc')"`, 'node inline code'],
    ['node --eval', 'node --eval "1"', 'node inline code'],
    ['a $VAR program', 'TSC=tsc; $TSC -p .', 'dynamic program'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell expansion
    ['a ${VAR} program', '${TSC} -p .', 'dynamic program'],
    ['a $(…) program', '$(npm bin)/tsc -p .', 'dynamic program'],
    ['make', `${TSC7} && make typecheck`, 'unknown program make'],
    ['node running a script', `${TSC7} && node scripts/tc.mjs`, 'unknown program scripts/tc.mjs'],
    ['python3 -c', `${TSC7} && python3 -c "import os"`, 'unknown program python3'],
    ['deno eval', `${TSC7} && deno eval "1"`, 'unknown program deno'],
    ['node with no file', `${TSC7} && node --version`, 'node runs no file'],
    ['turbo naming no task', `${TSC7} && turbo run`, 'turbo names no task'],
    ['a runner naming no script', `${TSC7} && bun run`, 'bun names no script'],
    ['a wrapper with no program', `${TSC7} && env FOO=1`, 'wrapper with no program'],
  ])('%s: is UNRESOLVED (fails closed)', (_label, typecheck, reason) => {
    const { unresolved } = run(lib({ typecheck }), [PLAIN_UI]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toContain(reason);
  });

  it.each([
    ['echo', `${TSC7} && echo ok`],
    ['true', `${TSC7} && true`],
    ['test', `test -d src && ${TSC7}`],
    ['[', `[ -d src ] && ${TSC7}`],
    ['node --check', `node --check bin/x.js && ${TSC7}`],
    ['set', `set -e && ${TSC7}`],
    ['exit', `${TSC7} && exit 0`],
    ['return', `${TSC7} && return 0`],
  ])('allowlisted non-compiler %s resolves cleanly', (_l, typecheck) => {
    expect(run(lib({ typecheck }))).toEqual({ tsc7: 1, plainTsc: [], unresolved: [] });
  });

  it('sh <file> follows the file and classifies its lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc7-guard-'));
    mkdirSync(join(dir, 'packages/lib/scripts'), { recursive: true });
    writeFileSync(join(dir, 'packages/lib/scripts/tc.sh'), '#!/bin/sh\n# comment\ntsc -p .\n');
    writeFileSync(join(dir, 'packages/lib/scripts/ok.sh'), `set -eu\n${TSC7}\n`);
    writeFileSync(join(dir, 'packages/lib/scripts/errexit.sh'), `set -e\n${TSC7}\necho done\n`);
    writeFileSync(join(dir, 'packages/lib/scripts/masked.sh'), `${TSC7}\necho done\n`);
    writeFileSync(join(dir, 'packages/lib/scripts/late-set.sh'), `${TSC7}\nset -e\necho done\n`);
    writeFileSync(join(dir, 'packages/lib/scripts/unset.sh'), `set -e\nset +e\n${TSC7}\necho x\n`);
    // `set +e` AFTER the tsc7 line does not un-enforce it: errexit was on when it ran
    writeFileSync(
      join(dir, 'packages/lib/scripts/unset-after.sh'),
      `set -e\n${TSC7}\nset +e\necho x\n`,
    );
    writeFileSync(join(dir, 'packages/lib/scripts/exit.sh'), `set -e\nexit 0\n${TSC7}\n`);
    writeFileSync(join(dir, 'packages/lib/scripts/comment.sh'), `echo skip # ${TSC7}\n`);
    writeFileSync(
      join(dir, 'packages/lib/scripts/quoted.sh'),
      `set -e\necho "skip\n${TSC7}\n"\necho done\n`,
    );
    writeFileSync(join(dir, 'packages/lib/scripts/cont.sh'), `echo a &&\n  ${TSC7} \\\n  -p .\n`);
    const at = (typecheck: string) => resolveChain(lib({ typecheck }), 'typecheck', [], dir);
    try {
      expect(at('sh scripts/tc.sh').plainTsc).toHaveLength(1);
      expect(at('bash ./scripts/tc.sh').plainTsc).toHaveLength(1);
      expect(at('./scripts/tc.sh').plainTsc).toHaveLength(1);
      expect(at('sh scripts/ok.sh')).toEqual({ tsc7: 1, plainTsc: [], unresolved: [] });
      // with `set -e` in effect, a tsc7 line that is not last is still enforced
      expect(at('sh scripts/errexit.sh')).toEqual({ tsc7: 1, plainTsc: [], unresolved: [] });
      // without `set -e` the LAST line's exit code is the script's, so the tsc7 line is masked
      expect(at('sh scripts/masked.sh').tsc7).toBe(0);
      // `set -e` must be in effect BEFORE the tsc7 line, and `set +e` turns it off again
      expect(at('sh scripts/late-set.sh').tsc7).toBe(0);
      expect(at('sh scripts/unset.sh').tsc7).toBe(0);
      expect(at('sh scripts/unset-after.sh').tsc7).toBe(1);
      // lines after an unconditional `exit` never run
      expect(at('sh scripts/exit.sh').tsc7).toBe(0);
      // a commented-out or quoted tsc7 is not a command
      expect(at('sh scripts/comment.sh')).toEqual({ tsc7: 0, plainTsc: [], unresolved: [] });
      expect(at('sh scripts/quoted.sh')).toEqual({ tsc7: 0, plainTsc: [], unresolved: [] });
      // a newline after `&&` and a backslash-newline both continue the command list
      expect(at('sh scripts/cont.sh')).toEqual({ tsc7: 1, plainTsc: [], unresolved: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['--version', '../../node_modules/typescript-tsc7/bin/tsc --version'],
    ['-p with --version', '../../node_modules/typescript-tsc7/bin/tsc -p x --version'],
    ['--noCheck', `${TSC7} --noCheck`],
    ['--noCheck=true', `${TSC7} --noCheck=true`],
    ['--watch', `${TSC7} --watch`],
    ['-w', `${TSC7} -w`],
    ['-b --clean', '../../node_modules/typescript-tsc7/bin/tsc -b --clean'],
    ['after `exit 0;`', `exit 0; ${TSC7}`],
    ['after `exit 0 &&`', `exit 0 && ${TSC7}`],
    ['after `return;`', `return; ${TSC7}`],
    ['no project/noEmit/build flag', '../../node_modules/typescript-tsc7/bin/tsc'],
    ['behind ||', `echo skip || ${TSC7}`],
    ['followed by || true', `${TSC7} || true`],
    ['followed by ;', `${TSC7}; echo done`],
    ['piped', `${TSC7} | cat`],
    ['backgrounded', `${TSC7} &`],
    ['&& then || later', `${TSC7} && echo ok || true`],
    ['inside a masked hop', 'bun run tc || true'],
    // tsc parses flags case-insensitively
    ['--nocheck', `${TSC7} --nocheck`],
    ['--NOCHECK', `${TSC7} --NOCHECK`],
    ['--WATCH', `${TSC7} --WATCH`],
    ['--Version', `${TSC7} --Version`],
    ['-? (help)', `${TSC7} -?`],
    // `-b --dry` exits 0 on a type error; in build mode `-d` is `--dry`
    ['-b --dry', `${B} --dry`],
    ['--build --DRY', '../../node_modules/typescript-tsc7/bin/tsc --build --DRY'],
    ['-b -d', `${B} -d`],
    ['-b -D', `${B} -D`],
    // separators inside quotes, after an escape, or in a comment are not separators
    ['inside double quotes', `echo "skip; ${TSC7}"`],
    ['inside single quotes', `echo 'skip && ${TSC7}'`],
    ['after an escaped ;', `echo skip \\; ${TSC7}`],
    ['in a comment', `echo skip # && ${TSC7}`],
    // `set -e` / `set +e` tracked per statement, not per line
    ['`set -e; set +e` on one line', `set -e; set +e; ${TSC7}; echo done`],
    ['`true && set +e`', `set -e; true && set +e; ${TSC7}; echo done`],
    ['conditional `true && set -e`', `true && set -e; ${TSC7}; echo done`],
    ['`set -e` in a pipeline (subshell)', `set -e | cat; ${TSC7}; echo done`],
    ['`set -e` backgrounded (subshell)', `set -e & ${TSC7}; echo done`],
    // a newline right after `||` continues the list, so tsc7 is still behind `||`
    ['behind || across a newline', `echo skip ||\n  ${TSC7}`],
    // info-only runs, whatever else they carry
    ['-v', `${TSC7} -v`],
    ['-h', `${TSC7} -h`],
    ['--help', `${TSC7} --help`],
    ['--all', `${TSC7} --all`],
    ['--init', `${TSC7} --init`],
    ['--showConfig', `${TSC7} --showConfig`],
    ['--listFilesOnly', `${TSC7} --listFilesOnly`],
    ['non-final && operand under set -e', `set -e; ${TSC7} && echo ok; echo done`],
  ])('a tsc7 invocation that is not an enforced typecheck does not count: %s', (_l, typecheck) => {
    expect(run(lib({ typecheck, tc: TSC7 })).tsc7).toBe(0);
  });

  it.each([
    ['-p', '../../node_modules/typescript-tsc7/bin/tsc -p tsconfig.json'],
    ['--project', '../../node_modules/typescript-tsc7/bin/tsc --project tsconfig.json'],
    ['--noEmit', TSC7],
    ['-b', '../../node_modules/typescript-tsc7/bin/tsc -b'],
    ['after && and ;', `echo a; echo b && ${TSC7}`],
    ['through an unmasked hop', 'echo a && bun run tc'],
    ['bun x', `bun x ${TSC7}`],
    ['pnpm exec', `pnpm exec ${TSC7}`],
    ['npm exec --', `npm exec -- ${TSC7}`],
    ['yarn exec', `yarn exec ${TSC7}`],
    ['bun <tsc7 entry>', `bun ${TSC7}`],
    ['--build', '../../node_modules/typescript-tsc7/bin/tsc --build'],
    ['--NOEMIT (case-insensitive)', '../../node_modules/typescript-tsc7/bin/tsc --NOEMIT'],
    ['-d outside build mode (--declaration)', `${TSC7} -d`],
    ['quoted separators before it', `echo "a; b" 'c || d' && ${TSC7}`],
    ['a # inside a word or quotes', `echo a#b '#' && ${TSC7}`],
    ['under `set -e`, followed by ;', `set -e; ${TSC7}; echo done`],
    ['under `set -o errexit`', `set -o errexit; ${TSC7}; echo done`],
    ['under `set -euo pipefail`', `set -euo pipefail && ${TSC7}; echo done`],
    // the `&` of a redirection is not a background separator
    ['with 2>&1', `${TSC7} 2>&1`],
    ['with >&2', `${TSC7} >&2`],
    ['with &>', `${TSC7} &>/dev/null`],
  ])('an enforced tsc7 typecheck counts: %s', (_l, typecheck) => {
    expect(run(lib({ typecheck, tc: TSC7 })).tsc7).toBe(1);
  });

  it('`set +o errexit` turns errexit off again', () => {
    const typecheck = `set -e; set +o errexit; ${TSC7}; echo done`;
    expect(run(lib({ typecheck })).tsc7).toBe(0);
  });

  it.each([
    ['$(…)', `echo $(tsc -p .) && ${TSC7}`],
    ['$(…) in double quotes', `echo "v=$(tsc --version)" && ${TSC7}`],
    ['backticks', `echo \`tsc -p .\` && ${TSC7}`],
    ['nested $(…)', `echo $(echo $(tsc -p .)) && ${TSC7}`],
    ['plain typescript lib', `echo $(node node_modules/typescript/lib/_tsc.js) && ${TSC7}`],
  ])('plain tsc inside a command substitution is caught: %s', (_l, typecheck) => {
    expect(run(lib({ typecheck })).plainTsc).toHaveLength(1);
  });
});
