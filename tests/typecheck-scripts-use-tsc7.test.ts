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
 *    `$VAR`/`$(…)`/backtick expansion, a missing script/file/manifest.
 *
 * Rules:
 *  - no command in any chain may invoke plain tsc: a bare `tsc` token, a
 *    `.bin/tsc`, or anything under the `typescript/` package's `bin/` or
 *    `lib/` (e.g. `node node_modules/typescript/lib/_tsc.js`);
 *  - the known tsc7 consumers' chains MUST reach an ENFORCED typecheck: a
 *    typescript-tsc7 invocation carrying `-p`/`--project`/`--noEmit`/`-b`
 *    (not `--version`/`--help`), whose exit code is not masked — not behind
 *    `||`, not followed by `||`/`;`/`|`/`&`, and not inside a masked hop;
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
const TYPECHECK_FLAG = /^(-p|--project|--noEmit|-b|--build)(=.*)?$/;
const INFO_FLAG = /^(-v|--version|-h|--help|--all|--init|--showConfig|--listFilesOnly)$/;
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

function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^['"]+|['"]+$/g, ''))
    .filter(Boolean);
}

interface Segment {
  text: string;
  tokens: string[];
  /** The shell would not propagate this command's exit code (or may not run it). */
  masked: boolean;
}

/** Split a command list on `&&`, `||`, `;`, `|`, `&` (not `2>&1`), newline; mark masked commands. */
function segments(script: string, inherited: boolean): Segment[] {
  const parts = script.split(/(&&|\|\||;|\||(?<![<>])&(?!>)|\n)/);
  const cmds = parts.filter((_, i) => i % 2 === 0);
  const seps = parts.filter((_, i) => i % 2 === 1);
  return cmds.map((text, k) => {
    const before = seps.slice(0, k);
    const after = seps.slice(k);
    const masked =
      inherited ||
      before.includes('||') ||
      after[0] === '|' ||
      after.some((s) => s === '||' || s === ';' || s === '&' || s === '\n');
    return { text, tokens: tokenize(text), masked };
  });
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
    const lines = readFileSync(abs, 'utf8')
      .replace(/\\\n/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    const errexit = lines.some((l) => /^set\s+(-[a-z]*e[a-z]*\b|-o\s+errexit)/.test(l));
    // Without `set -e`, only the last line's exit code is the script's.
    runList(p, `${p.path}>${rel}`, lines.join(errexit ? ' && ' : ' ; '), masked);
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
      if (prog === 'bun' && TSC7_BIN.test(script)) return compiler(script, rest.slice(1), masked);
      out.unresolved.push(`${key}: ${prog} ${script} is not a script of the targeted package(s)`);
      return;
    }
    for (const q of declaring) visitScript(q, script, masked);
  };

  const compiler = (prog: string, args: string[], masked: boolean) => {
    const enforced =
      args.some((a) => TYPECHECK_FLAG.test(a)) && !args.some((a) => INFO_FLAG.test(a));
    if (TSC7_BIN.test(prog) && enforced && !masked) out.tsc7++;
  };

  const classify = (p: Pkg, key: string, seg: Segment) => {
    const { tokens, masked } = seg;
    const text = seg.text.trim();
    if (tokens.length === 0) return;
    // plain-typescript references ANYWHERE in the command (catches `_tsc.js`, `.bin/tsc`)
    for (const t of tokens) {
      if (PLAIN_TS_PKG.test(t) || (TSC_LIKE.test(t) && !TSC7_BIN.test(t))) {
        out.plainTsc.push(`${key}: ${text}`);
      }
    }
    let i = 0;
    for (;;) {
      while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) i++;
      if (i >= tokens.length) return; // assignments only
      const t = tokens[i];
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
    if (i >= tokens.length) {
      out.unresolved.push(`${key}: wrapper with no program: ${text}`);
      return;
    }
    const prog = tokens[i];
    const args = tokens.slice(i + 1);
    const base = posix.basename(prog);
    if (DYNAMIC.test(prog) || prog.includes('`')) {
      out.unresolved.push(`${key}: dynamic program: ${text}`);
      return;
    }
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
      while (j < args.length && args[j].startsWith('-')) {
        if (/^(-e|--eval|-p|--print)(=.*)?$/.test(args[j])) {
          out.unresolved.push(`${key}: node inline code: ${text}`);
          return;
        }
        j += /^(-r|--require|--import)$/.test(args[j]) ? 2 : 1;
      }
      if (args[j] !== undefined) compiler(args[j], args.slice(j + 1), masked);
      return;
    }
    compiler(prog, args, masked);
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
  });

  it('flags the plain typescript package bin/lib, including `_tsc.js`', () => {
    expect(
      chainOf({ typecheck: 'node node_modules/typescript/lib/_tsc.js' }).plainTsc,
    ).toHaveLength(1);
    expect(chainOf({ typecheck: 'node_modules/typescript/bin/tsc' }).plainTsc).toHaveLength(1);
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
  const PLAIN_UI = ui({ 'typecheck:x': 'tsc --noEmit', tc: 'tsc --noEmit' });

  it.each([
    ['turbo shorthand without `run`', `${TSC7} && turbo typecheck:x`],
    ['bunx turbo run', `${TSC7} && bunx turbo run typecheck:x`],
    ['npx turbo run', `${TSC7} && npx turbo run typecheck:x`],
    ['turbo run with several tasks (not only the first)', `${TSC7} && turbo run test typecheck:x`],
    ['turbo run with a --filter', `${TSC7} && turbo run typecheck:x --filter=@getknext/ui`],
    ['npm --prefix <dir> run', `${TSC7} && npm --prefix ../ui run tc`],
    ['pnpm --filter <name> run', `${TSC7} && pnpm --filter @getknext/ui run tc`],
  ])('%s: follows into the plain-tsc target', (_label, typecheck) => {
    const c = run(lib({ typecheck, test: 'echo ok' }), [PLAIN_UI]);
    expect(c.unresolved).toEqual([]);
    expect(c.plainTsc.length).toBeGreaterThan(0);
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
  ])('%s: is UNRESOLVED (fails closed)', (_label, typecheck, reason) => {
    const { unresolved } = run(lib({ typecheck }), [PLAIN_UI]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toContain(reason);
  });

  it('sh <file> follows the file and classifies its lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc7-guard-'));
    mkdirSync(join(dir, 'packages/lib/scripts'), { recursive: true });
    writeFileSync(join(dir, 'packages/lib/scripts/tc.sh'), '#!/bin/sh\n# comment\ntsc -p .\n');
    writeFileSync(join(dir, 'packages/lib/scripts/ok.sh'), `set -eu\n${TSC7}\n`);
    writeFileSync(join(dir, 'packages/lib/scripts/masked.sh'), `${TSC7}\necho done\n`);
    const at = (typecheck: string) => resolveChain(lib({ typecheck }), 'typecheck', [], dir);
    try {
      expect(at('sh scripts/tc.sh').plainTsc).toHaveLength(1);
      expect(at('bash ./scripts/tc.sh').plainTsc).toHaveLength(1);
      expect(at('./scripts/tc.sh').plainTsc).toHaveLength(1);
      expect(at('sh scripts/ok.sh')).toEqual({ tsc7: 1, plainTsc: [], unresolved: [] });
      // without `set -e` the LAST line's exit code is the script's, so the tsc7 line is masked
      expect(at('sh scripts/masked.sh').tsc7).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['--version', '../../node_modules/typescript-tsc7/bin/tsc --version'],
    ['no project/noEmit/build flag', '../../node_modules/typescript-tsc7/bin/tsc'],
    ['behind ||', `echo skip || ${TSC7}`],
    ['followed by || true', `${TSC7} || true`],
    ['followed by ;', `${TSC7}; echo done`],
    ['piped', `${TSC7} | cat`],
    ['backgrounded', `${TSC7} &`],
    ['&& then || later', `${TSC7} && echo ok || true`],
    ['inside a masked hop', 'bun run tc || true'],
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
  ])('an enforced tsc7 typecheck counts: %s', (_l, typecheck) => {
    expect(run(lib({ typecheck, tc: TSC7 })).tsc7).toBe(1);
  });
});
