/**
 * The ADR-0052 D3 spawn scan: the deploy path never shells `func deploy` or
 * `kn service`.
 *
 * Scope: every non-test source file under `packages/kn-next/src/cli/` and
 * `packages/grpc/`. Rules, each of which FAILS rather than passes on a
 * construct it cannot read:
 *
 *   forbidden-spawn      a spawn whose program is `kn`, or `func` with a
 *                        `deploy` argument, however it is wrapped
 *                        (`env`, `sudo`, `sh -c`, a shell string, ...).
 *   forbidden-literal    the text `func deploy` / `kn service`, or the bare
 *                        program name "kn", in any string literal -
 *                        so building the command in a variable does not hide it.
 *   unparseable-spawn    a spawn whose program or argv is not a literal the
 *                        scan can read (a variable, a spread, a template with a
 *                        hole, a shell tagged template), unless it is on
 *                        {@link DYNAMIC_SPAWN_ALLOWLIST}.
 *   unparseable-import   a `child_process` import it cannot follow (namespace,
 *                        default, `require`, dynamic `import()`).
 *
 * `kn` is refused outright: the whole Knative client writes cluster state, and
 * the CLI has no use for it. `func build` (image only, no cluster write) is not
 * refused. Comments are blanked first, so documentation that NAMES the
 * prohibition is fine; a string is not.
 *
 * Pure functions over source text, plus a tree walker. The test is
 * `tests/cli-spawn-scan.test.ts`; the mutation proof is
 * `scripts/mutation-prove-2053-cli-cluster-write-surface.mjs`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  callArgs,
  classify,
  isIndexAccess,
  lineOf,
  matchClose,
  prepare,
  readLiteral,
  stringLiterals,
} from './ts-call-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directories scanned, relative to the repo root. */
export const SPAWN_SCOPE_DIRS = ['packages/kn-next/src/cli', 'packages/grpc'];

/** Path segments that are never part of the shipped CLI/package source. */
const EXCLUDED_SEGMENTS = new Set([
  '__tests__',
  'node_modules',
  'dist',
  'fixtures',
  'testdata',
  'proto',
  'templates',
]);

/** The project's exec helpers (`src/cli/exec.ts`): they take an argv array. */
const ARGV_WRAPPERS = new Set(['runInherit', 'runQuiet', 'runCapture', 'runQuietAllowFail']);
/** `child_process` calls taking (program, args[]). */
const FILE_STYLE = new Set(['execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']);
/** `child_process` calls taking one shell string. */
const SHELL_STYLE = new Set(['exec', 'execSync']);
const BUN_SPAWN = new Set(['Bun.spawn', 'Bun.spawnSync']);

/** Programs that run another program given as their arguments. */
const WRAPPER_PROGRAMS = new Set([
  'env',
  'sudo',
  'nohup',
  'time',
  'command',
  'exec',
  'xargs',
  'npx',
  'bunx',
  'nice',
  'timeout',
]);
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * Computed spawns that are safe, each EXACT (file + callee + the first
 * argument's text) and counted. The scan still checks every literal in these
 * files for `func`/`kn`, and every CALLER of these helpers is scanned at its own
 * call site, so what flows through them is read where it is written.
 *
 * An entry that matches no call site is reported stale (it fails the test), so
 * this list cannot outlive the code it excuses.
 */
export const DYNAMIC_SPAWN_ALLOWLIST = [
  {
    file: 'packages/kn-next/src/cli/exec.ts',
    callee: 'execFileSync',
    arg: 'cmd',
    count: 4,
    reason:
      'exec.ts is the CLI exec helper: runCapture/runInherit/runQuiet take an argv ARRAY and run ' +
      'argv[0] with shell:false. Every caller of those helpers is scanned at its own call site.',
  },
  {
    file: 'packages/kn-next/src/cli/exec.ts',
    callee: 'spawnSync',
    arg: 'cmd',
    reason:
      'exec.ts runQuietAllowFail: the same argv-array helper contract; its callers are scanned ' +
      'at their own call sites.',
  },
  {
    file: 'packages/kn-next/src/cli/db-bind.ts',
    callee: 'runCapture',
    arg: 'a',
    reason:
      'the exec seam handed to runDbBind: it forwards the argv runDbBind builds, whose literals ' +
      '("kubectl", "get"/"patch", "nextapp") are scanned where they are written.',
  },
  {
    file: 'packages/kn-next/src/cli/deploy.ts',
    callee: 'runInherit',
    arg: 'dockerBuildxArgs(...)',
    reason:
      'the docker buildx argv from dockerBuildxArgs(); that function is in scope and its ' +
      'program is the literal "docker".',
  },
  {
    file: 'packages/kn-next/src/cli/deploy.ts',
    callee: 'runCapture',
    arg: 'argv',
    reason:
      'the ExecFn seam resolveDigest() calls with its own docker/crane argv; those literals ' +
      'are scanned in cr-builder.ts where they are written.',
  },
  {
    file: 'packages/kn-next/src/cli/preview.ts',
    callee: 'runInherit',
    arg: 'dockerBuildxArgs(...)',
    reason:
      'the docker buildx argv from dockerBuildxArgs(); that function is in scope and its ' +
      'program is the literal "docker".',
  },
  {
    file: 'packages/kn-next/src/cli/preview.ts',
    callee: 'runCapture',
    arg: 'argv',
    reason:
      'the ExecFn seam resolveDigest() calls with its own docker/crane argv; those literals ' +
      'are scanned in cr-builder.ts where they are written.',
  },
  {
    file: 'packages/kn-next/src/cli/loadtest.ts',
    callee: 'execFileSync',
    arg: 'argv[0]',
    reason:
      'defaultLoadTestExec: runs the argv runLoadTest builds, whose only program is the literal ' +
      '"kubectl" (scanned, and kind-checked by the cluster-write scan).',
  },
  {
    file: 'packages/kn-next/src/cli/postcompile-smoke.ts',
    callee: 'spawn',
    arg: 'opts.binaryPath',
    reason:
      'the smoke test runs the single-executable binary the build just produced, by path; it is ' +
      'the app under test, not a cluster tool.',
  },
  {
    file: 'packages/kn-next/src/cli/vinext-build.ts',
    callee: 'runQuiet',
    arg: 'argv',
    reason:
      'the injectable run seam of the vinext build; its callers pass the literal argv ' +
      '("npx", "bun", ...) that this scan reads at each call site.',
  },
  {
    file: 'packages/kn-next/src/cli/vinext-build.ts',
    callee: 'execFileSync',
    arg: 'bin',
    reason:
      'detectBunVersion(bin = "bun"): reads `--version` of the bun binary; the default is the ' +
      'literal "bun".',
  },
  {
    file: 'packages/grpc/src/buf.ts',
    callee: 'spawnSync',
    arg: 'bin',
    reason:
      'runBuf: `bin` is the buf binary resolved and checked against the pinned digest before it ' +
      'is run (resolveBufBinary); it is buf, never func or kn.',
  },
];

const base = (p) => p.replace(/^.*\//, '');

/**
 * Whether a shell command line runs `kn`, or `func` with `deploy`.
 * Returns a reason string, `'unparseable'`, or `undefined`.
 */
function shellProblem(command, depth = 0) {
  if (depth > 4) return 'unparseable';
  const segments = command.split(/&&|\|\||[;&|\n`()]|\$\(/);
  for (const raw of segments) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    while (words.length > 0 && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
    if (words.length === 0) continue;
    const verdict = argvProblem(
      words.map((w) => ({ type: 'string', value: w.replace(/^["']|["']$/g, '') })),
      depth + 1,
    );
    if (verdict) return verdict;
  }
  return undefined;
}

/**
 * Whether an argv (classified elements) runs `kn`, or `func` with `deploy`.
 * Returns a reason string, `'unparseable'`, or `undefined`.
 */
function argvProblem(elems, depth = 0) {
  if (depth > 6) return 'unparseable';
  const [head, ...rest] = elems;
  if (!head) return undefined;
  if (head.type !== 'string') return 'unparseable';
  const prog = base(head.value.trim());

  if (prog === 'kn') return 'kn is never run by the CLI';
  if (prog === 'func') {
    if (rest.some((e) => e.type === 'string' && e.value.trim() === 'deploy')) {
      return 'func deploy is prohibited (the operator is the only reconciler)';
    }
    // The subcommand is the first non-flag element; it must be a literal we
    // can read (a computed one might be `deploy`). Later arguments may be
    // computed: `func build --registry <ref>`.
    const sub = rest.find((e) => !(e.type === 'string' && e.value.startsWith('-')));
    if (sub && sub.type !== 'string') return 'unparseable';
    return undefined;
  }
  if (SHELL_PROGRAMS.has(prog)) {
    const i = rest.findIndex((e) => e.type === 'string' && /^-\w*c\w*$/.test(e.value));
    if (i === -1) return rest.length === 0 ? undefined : 'unparseable';
    const cmd = rest[i + 1];
    if (!cmd || cmd.type !== 'string') return 'unparseable';
    return shellProblem(cmd.value, depth + 1);
  }
  if (WRAPPER_PROGRAMS.has(prog)) {
    const inner = [];
    let started = false;
    for (const e of rest) {
      if (
        !started &&
        e.type === 'string' &&
        (e.value.startsWith('-') || /^[A-Za-z_]\w*=/.test(e.value))
      )
        continue;
      started = true;
      inner.push(e);
    }
    return argvProblem(inner, depth + 1);
  }
  return undefined;
}

/** Unwrap `withKubeContext([...], ctx)`, the one transparent wrapper in the CLI. */
function unwrap(node) {
  if (node?.type === 'call' && node.name === 'withKubeContext' && node.args[0]) {
    return unwrap(node.args[0]);
  }
  return node;
}

/**
 * The problem with one spawn call, or `undefined` if it is safe.
 * `{ reason }` for a prohibited program, `{ unparseable }` for one not readable.
 */
function spawnProblem(kind, args) {
  const first = unwrap(args[0]);
  if (!first) return { unparseable: 'a spawn with no argument' };

  if (kind === 'argv') {
    if (first.type === 'array') {
      const v = argvProblem(first.elems);
      return v === 'unparseable'
        ? { unparseable: `argv ${first.text}` }
        : v
          ? { reason: v }
          : undefined;
    }
    if (first.type === 'string') {
      const v = shellProblem(first.value);
      return v === 'unparseable'
        ? { unparseable: `command ${first.text}` }
        : v
          ? { reason: v }
          : undefined;
    }
    return { unparseable: `argv ${first.text}` };
  }
  if (kind === 'file') {
    const second = args[1] ? unwrap(args[1]) : undefined;
    const tail = !second ? [] : second.type === 'array' ? second.elems : [{ type: 'dynamic' }];
    const v = argvProblem([first, ...tail]);
    return v === 'unparseable'
      ? { unparseable: `program ${first.text}` }
      : v
        ? { reason: v }
        : undefined;
  }
  // shell. A local seam that happens to be NAMED exec/execSync but is handed an
  // argv array is read as an argv (child_process would reject an array anyway).
  if (first.type === 'array') {
    const v = argvProblem(first.elems);
    return v === 'unparseable'
      ? { unparseable: `argv ${first.text}` }
      : v
        ? { reason: v }
        : undefined;
  }
  if (first.type === 'string') {
    const v = shellProblem(first.value);
    return v === 'unparseable'
      ? { unparseable: `command ${first.text}` }
      : v
        ? { reason: v }
        : undefined;
  }
  return { unparseable: `shell command ${first.text}` };
}

const CP_MODULE = /^(?:node:)?child_process$/;
const EXEC_MODULE = /(?:^|\/)exec(?:\.[cm]?[jt]s)?$/;

/**
 * Local names for spawn callees in this file: the base set, plus any `as`
 * alias of a named import from `child_process` or the exec helper module.
 * Imports it cannot follow become violations.
 */
function importAliases(p, push) {
  const { s, b } = p;
  const alias = new Map(); // local name -> original callee name
  const re = /\bimport\s+([^;'"`]*?)\s*from\s*(['"])/g;
  for (let m = re.exec(b); m; m = re.exec(b)) {
    const q = m.index + m[0].length - 1;
    const spec = s.slice(q + 1, readLiteral(b, q) - 1);
    const isCp = CP_MODULE.test(spec);
    if (!isCp && !EXEC_MODULE.test(spec)) continue;
    const clause = s
      .slice(m.index + 'import'.length, q)
      .replace(/from\s*$/, '')
      .trim();
    const named = /\{([^}]*)\}/.exec(clause);
    const outside = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, '')
      .trim();
    if (isCp && outside !== '') {
      push(
        'unparseable-import',
        m.index,
        `child_process imported as a ${/\*/.test(outside) ? 'namespace' : 'default'} ("${clause}")`,
      );
    }
    if (!isCp && outside !== '') continue; // a default import of the exec helper: not a callee alias
    for (const part of (named?.[1] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const mm = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(part);
      if (mm) alias.set(mm[2] ?? mm[1], mm[1]);
    }
  }
  const reqRe = /\brequire\s*\(\s*(['"])/g;
  for (let m = reqRe.exec(b); m; m = reqRe.exec(b)) {
    const q = m.index + m[0].length - 1;
    if (CP_MODULE.test(s.slice(q + 1, readLiteral(b, q) - 1))) {
      push('unparseable-import', m.index, 'child_process loaded with require()');
    }
  }
  const dynRe = /\bimport\s*\(\s*(['"])/g;
  for (let m = dynRe.exec(b); m; m = dynRe.exec(b)) {
    const q = m.index + m[0].length - 1;
    if (CP_MODULE.test(s.slice(q + 1, readLiteral(b, q) - 1))) {
      push('unparseable-import', m.index, 'child_process loaded with a dynamic import()');
    }
  }
  return alias;
}

/**
 * Scan one source file.
 *
 * @param {string} src
 * @param {{ file: string, allow?: Array<{file: string, callee: string, arg: string, count?: number, reason?: string}> }} opts
 */
export function scanSpawnSource(src, { file, allow = DYNAMIC_SPAWN_ALLOWLIST }) {
  const p = prepare(src);
  const { b } = p;
  const violations = [];
  const push = (rule, index, detail) =>
    violations.push({ rule, file, line: lineOf(src, index), detail });

  const alias = importAliases(p, push);
  const kindOf = (name) => {
    const orig = alias.get(name) ?? name;
    if (ARGV_WRAPPERS.has(orig)) return 'argv';
    if (FILE_STYLE.has(orig)) return 'file';
    if (SHELL_STYLE.has(orig)) return 'shell';
    return undefined;
  };

  // Allowlist bookkeeping for this file.
  const mine = allow
    .filter((e) => e.file === file)
    .map((e) => ({ ...e, left: e.count ?? 1, used: 0 }));

  let spawnCount = 0;
  const callRe = /(?<![\w$.])(Bun\s*\.\s*spawnSync|Bun\s*\.\s*spawn|[A-Za-z_$][\w$]*)\s*\(/g;
  for (let m = callRe.exec(b); m; m = callRe.exec(b)) {
    const name = m[1].replace(/\s+/g, '');
    const kind = BUN_SPAWN.has(name) ? 'argv' : kindOf(name);
    if (!kind) continue;
    // A declaration (`function exec(`), not a call.
    const before = b.slice(Math.max(0, m.index - 12), m.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue;
    spawnCount++;
    const open = m.index + m[0].length - 1;
    const args = callArgs(p, open);
    const problem = spawnProblem(kind, args);
    if (!problem) continue;
    if (problem.reason) {
      push('forbidden-spawn', m.index, `${name}(): ${problem.reason}`);
      continue;
    }
    const first = unwrap(args[0]);
    const key = first?.type === 'call' ? `${first.name}(...)` : (first?.text ?? '');
    const entry = mine.find(
      (e) => e.callee === (alias.get(name) ?? name) && e.arg === key && e.left > 0,
    );
    if (entry) {
      entry.left -= 1;
      entry.used += 1;
      continue;
    }
    push('unparseable-spawn', m.index, `${name}(${key}): ${problem.unparseable}`);
  }

  // An argv ARRAY naming `kn`, or `func` with `deploy`, anywhere - not only as the
  // argument of a recognised spawn. Handing it to a seam (`host.run([...])`) or
  // binding it to a variable (`const cmd = [...]`) does not make it safe.
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== '[') continue;
    if (isIndexAccess(b, i)) continue; // an index access, not a literal
    const arr = classify(p, [i, matchClose(b, i) + 1]);
    if (arr.type !== 'array' || arr.elems[0]?.type !== 'string') continue;
    const verdict = argvProblem(arr.elems);
    if (verdict && verdict !== 'unparseable')
      push('forbidden-spawn', i, `argv ${arr.text}: ${verdict}`);
  }

  // A shell tagged template ($`...`) is never readable here.
  const tagRe = /(?<![\w$])\$\s*`/g;
  for (let m = tagRe.exec(b); m; m = tagRe.exec(b)) {
    spawnCount++;
    push('unparseable-spawn', m.index, 'a shell tagged template ($`...`) cannot be read');
  }

  // The prohibited command, anywhere a string can carry it.
  for (const lit of stringLiterals(p)) {
    const text = lit.value;
    const phrase = /\bfunc\s+deploy\b/.test(text) || /\bkn\s+service(s)?\b/.test(text);
    const bare = !lit.hole && text.trim() === 'kn';
    if (phrase || bare) {
      push('forbidden-literal', lit.index, `string literal ${JSON.stringify(text.slice(0, 60))}`);
    }
  }

  // The same argv can be found by the call-site rule and the array rule.
  const seen = new Set();
  const unique = violations.filter((v) => {
    const key = `${v.rule}:${v.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const unusedAllow = mine
    .filter((e) => e.used < (e.count ?? 1))
    .map((e) => ({ file: e.file, callee: e.callee, arg: e.arg, unused: (e.count ?? 1) - e.used }));
  return { violations: unique, spawnCount, unusedAllow };
}

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (EXCLUDED_SEGMENTS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(full);
  }
}

/** Repo-relative paths of every file in scope. */
export function spawnScopeFiles(root = REPO_ROOT) {
  const files = [];
  for (const d of SPAWN_SCOPE_DIRS) walk(join(root, d), files);
  return files.map((f) => relative(root, f).split('\\').join('/'));
}

/** Scan every file in scope. */
export function scanSpawnTree(root = REPO_ROOT, allow = DYNAMIC_SPAWN_ALLOWLIST) {
  const violations = [];
  let spawnCount = 0;
  const usedBy = new Map();
  const files = spawnScopeFiles(root);
  for (const file of files) {
    const r = scanSpawnSource(readFileSync(join(root, file), 'utf8'), { file, allow });
    violations.push(...r.violations);
    spawnCount += r.spawnCount;
    for (const u of r.unusedAllow) usedBy.set(`${u.file} ${u.callee} ${u.arg}`, u);
  }
  // An allowlist entry for a file outside the scope can never match: stale.
  const unusedAllow = [...usedBy.values()];
  for (const e of allow) {
    if (!files.includes(e.file))
      unusedAllow.push({ file: e.file, callee: e.callee, arg: e.arg, unused: e.count ?? 1 });
  }
  return { violations, spawnCount, unusedAllow, files };
}

export { classify };
