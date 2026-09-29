#!/usr/bin/env node
/**
 * workflow-script-install-guard.mjs — #1639(a).
 *
 * A publish-blocking job in release.yml once ran `node scripts/ga-tarball-diff-gate.mjs`
 * with no `bun install` step first, crashed on a missing `tar` import, and
 * silently SKIPPED the rc.1 publish (fixed for that one job by #1621, root
 * caused as #1622). Nothing generalized the fix: any OTHER workflow job that
 * runs a `scripts/*.mjs` file whose import closure reaches a real npm package,
 * with no install step earlier in the same job, is the same failure waiting
 * to happen.
 *
 * This scans every tracked `.github/workflows/*.yml` for a `run:` step
 * invoking `node scripts/<x>.mjs` / `bun scripts/<x>.mjs` / `bun run
 * scripts/<x>.mjs`, computes that script's import closure with
 * `scripts/adapter-import-closure.mjs`'s `computeAdapterClosure` (the same
 * relative-import walker ADR-0039's CLI-execution guard uses — reused here
 * rather than re-implemented), and reports a violation for any such step
 * whose closure reaches a non-`node:` bare specifier with no
 * `bun install|npm ci|npm install|pnpm install` step earlier in the SAME job.
 *
 * FAILS CLOSED, inherited from `computeAdapterClosure`: an unresolvable
 * relative import throws rather than being silently dropped from the
 * closure — a walker that swallows what it cannot resolve is how this class
 * of guard goes permanently green. A script whose closure cannot be computed
 * at all is therefore a hard error, not a skip.
 *
 * ALSO follows a `spawnSync`/`spawn`/`execFile`/`execFileSync`/`fork` call
 * that dispatches to another `scripts/*.mjs` file (round 2, #1639 review) —
 * e.g. `ga-tarball-diff-gate.mjs` spawning `ga-tarball-diff.mjs` as a
 * separate `node` process specifically so `tar` never enters ITS OWN module
 * graph (see that file's own header comment). That was the exact blind spot
 * the earlier revision of this comment claimed away: the spawned script's
 * job STILL runs in the SAME CI job, so a missing install step still crashes
 * it, just one process hop later — "the spawned script isn't imported into
 * THIS process" was true and irrelevant; what matters is whether the JOB has
 * an install step before anything in it, directly or via a spawned script,
 * needs `node_modules`.
 *
 * Spawn-target resolution is STATIC, same posture as relative-import
 * resolution above: a literal `scripts/<x>.mjs`, `join(__dirname, '<x>.mjs')`
 * / `path.resolve(__dirname, '<x>.mjs')` (directly inline OR via a single
 * local `const` binding — `ga-tarball-diff-gate.mjs`'s own
 * `const diffScript = join(__dirname, 'ga-tarball-diff.mjs')` shape), or
 * `new URL('<x>.mjs', import.meta.url)`. Scoped to calls that dispatch a JS
 * runtime (`node` / `bun` / `process.execPath`, or `child_process.fork`,
 * which is always a module dispatch) — a `spawnSync('git', ...)` or
 * `execFileSync('gsutil', ...)` is not spawning knext script code at all and
 * is out of scope for this guard. A JS-runtime dispatch whose target cannot
 * be resolved to one of those forms is a hard error (fails closed), same
 * rationale as an unresolvable relative import: a spawn target this walker
 * cannot see is exactly the class of blind spot #1621/#1622 exploited.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { computeAdapterClosure } from './adapter-import-closure.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

// `bun run scripts/x.mjs` before `bun scripts/x.mjs` in the alternation so the
// longer form isn't left partially matched by the shorter one first.
//
// OUT OF SCOPE (round 2, #1639 review finding 2 — tracked as #1652, not fixed
// here): `bun run <package.json-script-name>` / `npm run <name>` (used
// throughout ci.yml — `bun run lint`, `bun run typecheck`, …) is NOT resolved
// through package.json's `scripts` map, so a `scripts/*.mjs` file reached only
// that way is invisible to this scan. A composite action under
// `.github/actions/**` whose own `run:` steps invoke a `scripts/*.mjs` file
// would be equally invisible, but the repo has no such action today, so that
// half is latent only. Neither is silently assumed safe — see #1652.
const SCRIPT_RUN_RE = /\b(?:node|bun run|bun)\s+(scripts\/[\w./-]+\.mjs)\b/;
const INSTALL_RE = /\b(?:bun\s+install|npm\s+ci|npm\s+install|pnpm\s+install)\b/;

/** @returns {string[]} tracked workflow filenames, sorted. */
export function trackedWorkflowFiles(workflowsDir = WORKFLOWS_DIR) {
  return readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

const closureCache = new Map();

/** The import closure (files + non-`node:` externals) for a single entry file, cached by absolute path. */
function importClosureFor(scriptAbsPath, repoRoot) {
  const cacheKey = `${repoRoot}::${scriptAbsPath}`;
  if (closureCache.has(cacheKey)) return closureCache.get(cacheKey);
  const { files, externals } = computeAdapterClosure(scriptAbsPath, { packageRoot: repoRoot });
  const result = { files, packages: externals.filter((s) => !s.startsWith('node:')) };
  closureCache.set(cacheKey, result);
  return result;
}

const SPAWN_FN_NAMES = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
const JS_RUNTIME_TOKENS = new Set([
  'process.execPath',
  "'node'",
  '"node"',
  '`node`',
  "'bun'",
  '"bun"',
  '`bun`',
]);

/** Strip comments, same rule as adapter-import-closure.mjs, so a commented-out spawn call never counts. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Split a call's argument text on TOP-LEVEL commas (not nested in `()`/`[]`/`{}`, not inside a string). */
function splitTopLevelArgs(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((p) => p.trim());
}

/** Every balanced-paren `name(...)` call's argument text, for `name` in `names`. */
function callArgTexts(source, names) {
  const calls = [];
  const re = new RegExp(`\\b(${names.join('|')})\\s*\\(`, 'g');
  let m = re.exec(source);
  while (m !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    let quote = null;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (quote) {
        if (ch === quote && source[i - 1] !== '\\') quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
      i++;
    }
    calls.push({ name: m[1], argText: source.slice(start, i - 1) });
    re.lastIndex = i;
    m = re.exec(source);
  }
  return calls;
}

/** `join(__dirname, 'lit')` / `path.resolve(__dirname, 'lit')` / `new URL('lit', import.meta.url)` → `'lit'`, or null. */
function staticDirnameTarget(exprText) {
  const joinMatch = exprText.match(
    /^(?:path\.)?(?:join|resolve)\(\s*__dirname\s*,\s*(['"`])([^'"`]+)\1\s*\)$/,
  );
  if (joinMatch) return joinMatch[2];
  const urlMatch = exprText.match(
    /^new\s+URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url\s*\)$/,
  );
  if (urlMatch) return urlMatch[2];
  return null;
}

/**
 * Whether a JS-runtime dispatch's target argument is plausibly attempting to
 * name a script (so an unresolvable one must fail closed) versus a `bun`
 * bareword subcommand (`'install'`, `'run'`, `'test'`, `'pm'`, …) or a
 * property-access/computed expression this walker was never meant to fully
 * evaluate (e.g. a dynamically-discovered file list) — those are silently
 * skipped rather than failed closed, same bounded posture as
 * `localDirnameBindings`'s "single-hop, not full data-flow" note above.
 */
function looksLikeScriptTarget(candidate) {
  if (/^(['"`])[^'"`]*\.mjs\1$/.test(candidate)) return true;
  if (staticDirnameTarget(candidate)) return true;
  return /^[A-Za-z_$][\w$]*$/.test(candidate);
}

/**
 * Local `const NAME = <static-dirname-target>` bindings anywhere in `source`, so a
 * spawn call passing the BOUND NAME (e.g. `ga-tarball-diff-gate.mjs`'s
 * `const diffScript = join(__dirname, 'ga-tarball-diff.mjs')`) still resolves.
 * Single-hop only — deliberately not a full data-flow analysis.
 */
function localDirnameBindings(source) {
  const bindings = new Map();
  const re = /\bconst\s+(\w+)\s*=\s*([^;\n]+)/g;
  let m = re.exec(source);
  while (m !== null) {
    const target = staticDirnameTarget(m[2].trim());
    if (target) bindings.set(m[1], target);
    m = re.exec(source);
  }
  return bindings;
}

/**
 * Every `scripts/<x>.mjs` a JS-runtime spawn/exec/fork call in `scriptAbsPath`
 * dispatches to, resolved relative to `repoRoot`. THROWS when a JS-runtime
 * dispatch's target cannot be resolved to a recognized static form — see the
 * module header for why that fails closed rather than skips.
 *
 * @param {string} scriptAbsPath
 * @param {string} repoRoot
 * @returns {string[]} repo-root-relative script paths
 */
export function spawnedScriptsOf(scriptAbsPath, repoRoot = REPO_ROOT) {
  const source = stripComments(readFileSync(scriptAbsPath, 'utf8'));
  const fileDir = dirname(scriptAbsPath);
  const bindings = localDirnameBindings(source);
  const results = new Set();

  const resolveCandidate = (candidate) => {
    const literalMatch = candidate.match(/^(['"`])([^'"`]+\.mjs)\1$/);
    if (literalMatch) {
      const literal = literalMatch[2];
      const abs = literal.startsWith('scripts/')
        ? resolve(repoRoot, literal)
        : resolve(fileDir, literal);
      return abs;
    }
    const inlineTarget = staticDirnameTarget(candidate);
    if (inlineTarget) return resolve(fileDir, inlineTarget);
    const boundTarget = bindings.get(candidate);
    if (boundTarget) return resolve(fileDir, boundTarget);
    return null;
  };

  for (const { name, argText } of callArgTexts(source, SPAWN_FN_NAMES)) {
    const args = splitTopLevelArgs(argText);
    if (args.length === 0) continue;
    const command = args[0];

    // `fork(modulePath, ...)` always dispatches a JS module directly — no runtime prefix.
    if (name === 'fork') {
      const abs = resolveCandidate(command);
      if (!abs) {
        throw new Error(
          `workflow-script-install-guard: cannot statically resolve the module \`fork(...)\` ` +
            `dispatches in ${relative(repoRoot, scriptAbsPath)} — a spawn target this walker ` +
            'cannot see is exactly the #1621/#1622 blind spot. Rewrite the target as a literal ' +
            "`scripts/<x>.mjs`, `join(__dirname, '<x>.mjs')`/`resolve(__dirname, ...)`, or " +
            "`new URL('<x>.mjs', import.meta.url)` so it can be resolved statically.",
        );
      }
      results.add(relative(repoRoot, abs).split('\\').join('/'));
      continue;
    }

    if (!JS_RUNTIME_TOKENS.has(command)) {
      // spawn/execFile with a non-runtime command (`git`, `gsutil`, …): not a
      // knext-script dispatch at all — but a directly-executable script path
      // (`spawnSync('scripts/x.mjs', ...)`) is still worth resolving if present.
      const abs = resolveCandidate(command);
      if (abs) results.add(relative(repoRoot, abs).split('\\').join('/'));
      continue;
    }

    // JS-runtime dispatch (`node`/`bun`/`process.execPath`): the real target,
    // when there is one, is the first non-flag element of the args array (2nd
    // positional argument) — but `bun` doubles as a general CLI (`bun install`,
    // `bun run <pkg-script>`, `bun test`, …), so a plain bareword subcommand
    // (`'install'`, `'build'`, …) is not a script dispatch at all and is
    // silently skipped, not failed closed. `bun run <pkg-script-name>`
    // resolving to a package.json script is a distinct, separately-scoped gap
    // (see `SCRIPT_RUN_RE`'s own header note) — not this walker's job.
    const argsArrayText = args[1];
    const arrMatch = argsArrayText?.match(/^\[([\s\S]*)\]$/);
    const elements = arrMatch ? splitTopLevelArgs(arrMatch[1]) : [];
    const target = elements.find((el) => !/^(['"`])-/.test(el));
    if (!target || !looksLikeScriptTarget(target)) continue;
    const abs = resolveCandidate(target);
    if (!abs) {
      throw new Error(
        `workflow-script-install-guard: cannot statically resolve the script \`${name}(${command}, ...)\` ` +
          `dispatches in ${relative(repoRoot, scriptAbsPath)} — a spawn target this walker cannot ` +
          'see is exactly the #1621/#1622 blind spot. Rewrite the target as a literal ' +
          "`scripts/<x>.mjs`, `join(__dirname, '<x>.mjs')`/`resolve(__dirname, ...)`, or " +
          "`new URL('<x>.mjs', import.meta.url)` so it can be resolved statically.",
      );
    }
    results.add(relative(repoRoot, abs).split('\\').join('/'));
  }

  return [...results];
}

/**
 * The non-`node:` bare specifiers `scriptRelPath`'s EFFECTIVE closure reaches —
 * its own import closure, PLUS the import closures of every `scripts/*.mjs`
 * file it (transitively) spawns as a JS-runtime child process — from repo
 * root (never CWD — a relative path resolved against the wrong root is how
 * this class of check silently checks nothing).
 *
 * @param {string} scriptRelPath e.g. `scripts/audit-published.mjs`
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function nonBuiltinPackagesFor(scriptRelPath, repoRoot = REPO_ROOT) {
  const packages = new Set();
  const seenEntries = new Set();
  const queue = [scriptRelPath];

  while (queue.length > 0) {
    const relPath = queue.pop();
    if (seenEntries.has(relPath)) continue;
    seenEntries.add(relPath);

    const entryAbs = resolve(repoRoot, relPath);
    const { files, packages: entryPackages } = importClosureFor(entryAbs, repoRoot);
    for (const p of entryPackages) packages.add(p);

    for (const file of files) {
      for (const spawned of spawnedScriptsOf(file, repoRoot)) {
        if (!seenEntries.has(spawned)) queue.push(spawned);
      }
    }
  }

  return [...packages];
}

/**
 * @typedef {{ workflow: string, jobId: string, script: string, packages: string[] }} Violation
 */

/**
 * The step's effective `scripts/<x>.mjs` path RELATIVE TO REPO ROOT, honoring
 * `working-directory:` — a step-level `working-directory:` (falling back to
 * the job's `defaults.run.working-directory`, falling back to the workflow's
 * own top-level `defaults.run.working-directory`) changes where a bare
 * `scripts/x.mjs` in `run:` actually resolves from. Missing this produced a
 * false "file does not exist" on a real workflow during development (ci.yml's
 * `compat-smoke` job runs `node scripts/compat-smoke.mjs` with
 * `working-directory: apps/file-manager`, which is a DIFFERENT file from repo
 * root's `scripts/compat-smoke.mjs`) — this is checked against that real case
 * in the test file, not assumed.
 *
 * @param {string} scriptRelPathInStep the raw `scripts/<x>.mjs` text matched in `run:`
 * @param {{ workingDirectory?: string }} step
 * @param {{ workingDirectory?: string }} job
 * @param {{ workingDirectory?: string }} workflow
 * @param {string} repoRoot
 * @returns {string} path relative to repoRoot, forward-slash separated
 */
export function resolveScriptPath(scriptRelPathInStep, step, job, workflow, repoRoot) {
  const cwd = step.workingDirectory ?? job.workingDirectory ?? workflow.workingDirectory ?? '.';
  const absolute = resolve(repoRoot, cwd, scriptRelPathInStep);
  return relative(repoRoot, absolute).split('\\').join('/');
}

/**
 * @param {{ workflowsDir?: string, files?: string[], repoRoot?: string }} [opts]
 * @returns {Violation[]}
 */
export function findViolations({
  workflowsDir = WORKFLOWS_DIR,
  files = trackedWorkflowFiles(workflowsDir),
  repoRoot = REPO_ROOT,
} = {}) {
  /** @type {Violation[]} */
  const violations = [];
  for (const file of files) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    const doc = parse(text);
    const workflowCwd = { workingDirectory: doc?.defaults?.run?.['working-directory'] };
    const jobs = doc?.jobs && typeof doc.jobs === 'object' ? doc.jobs : {};
    for (const [jobId, job] of Object.entries(jobs)) {
      const jobCwd = { workingDirectory: job?.defaults?.run?.['working-directory'] };
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      let installSeen = false;
      for (const step of steps) {
        const run = typeof step?.run === 'string' ? step.run : '';
        if (run === '') continue;
        if (INSTALL_RE.test(run)) {
          installSeen = true;
          continue;
        }
        if (installSeen) continue; // already compliant for this job — no need to walk the closure
        const match = SCRIPT_RUN_RE.exec(run);
        if (!match) continue;
        const stepCwd = { workingDirectory: step['working-directory'] };
        const scriptRelPath = resolveScriptPath(match[1], stepCwd, jobCwd, workflowCwd, repoRoot);
        const packages = nonBuiltinPackagesFor(scriptRelPath, repoRoot);
        if (packages.length > 0) {
          violations.push({ workflow: file, jobId, script: scriptRelPath, packages });
        }
      }
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const violations = findViolations();
    if (violations.length > 0) {
      for (const v of violations) {
        console.error(
          `::error::${v.workflow} [job ${v.jobId}] runs \`${v.script}\` (reaches ${v.packages.join(', ')}) with no dependency-install step earlier in the job`,
        );
      }
      process.exit(1);
    }
    console.log(
      `workflow-script-install-guard: ${trackedWorkflowFiles().length} workflow(s) scanned, no violations ` +
        '(does not resolve `bun run <pkg-script>` / `npm run <name>` indirection — see #1652)',
    );
  } catch (err) {
    console.error(`::error::workflow-script-install-guard failed closed: ${err.message}`);
    process.exit(1);
  }
}
