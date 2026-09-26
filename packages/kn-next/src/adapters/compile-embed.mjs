/**
 * Shared embed module for the self-contained single executable (#1451): put a
 * set of files INTO a `bun build --compile` binary so a computed `import()` /
 * `require()` finds them at `$bunfs/root/<same relative path>`, with no
 * `node_modules`, `.next/` or `.output/` beside the binary.
 *
 * ## How (stock Bun)
 *
 * Bun only embeds an entry's static import graph. Every OTHER entrypoint of a
 * compile is embedded too, unexecuted, at its naming-template path — so the
 * set is passed as extra entrypoints with `root` = the tree's root and the
 * hash-free naming `[dir]/[name].[ext]`. Measured on Bun 1.4.2 (darwin-arm64):
 *
 *   - nested paths keep their shape (`a/b/c.js` → `$bunfs/root/a/b/c.js`);
 *   - the extension becomes `.js` (`x.cjs`, `x.mjs`, `x.ts` → `x.js`); a
 *     request for `./x.cjs` still resolves, but two sources that map to one
 *     path collide, so the plan refuses them;
 *   - included modules DO get bytecode under `--bytecode` (their own
 *     `// @bun @bytecode` pragma and constant pool; verifyBytecodeExec reads
 *     them unchanged);
 *   - `import.meta.dirname` in an ESM-format module is `/$bunfs/root/<dir>` at
 *     runtime, but `__dirname`/`__filename` in a CommonJS module (and
 *     `import.meta.dirname` under `format: "cjs"`) are inlined as the BUILD
 *     directory. A CommonJS module that anchors a computed require on
 *     `__dirname` therefore does not resolve from an empty directory; a
 *     RELATIVE computed require (`require("./" + n)`) does.
 *   - with `format: "esm"`, a CommonJS file passed as an entrypoint is
 *     converted to ESM and `require()` of it returns `{ default }`, not its
 *     `module.exports` — CommonJS trees must be compiled with `format: "cjs"`.
 *
 * When the pinned Bun supports `compile.include` (oven-sh/bun#44059), the same
 * plan is passed that way instead; `detectCompileInclude` decides, by running a
 * real compile, and the upstream-retirement harness holds the fallback to it.
 *
 * Dependency-free over node builtins and the sibling scanners, so a compile
 * script can bundle it and a fixture entry can import `runEmbedProbe`.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { computedRequireSites } from './computed-require-scan.mjs';
import { analyzeServerModule } from './entry-require-staticize.mjs';

/** The env var a fixture/entry reads to answer `assertPathFidelity`. */
export const EMBED_PROBE_ENV = 'KNEXT_EMBED_PROBE';
const PROBE_LINE = 'KNEXT_EMBED_PROBE_RESULT ';

const MODULE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const GLOB_META = /[*?[\]{}]/;

/** Where Bun embeds a JS/TS source compiled as an entrypoint: `[dir]/[name].js`. */
export function embeddedPath(rel) {
  return rel.replace(MODULE_EXT, '.js');
}

const toPosix = (p) => p.split(sep).join('/');

function walkFiles(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, root, out);
    else if (entry.isFile()) out.push(toPosix(relative(root, path)));
  }
}

/**
 * Expand `include` (literal files, directories — recursive — or globs, all
 * relative to `root`) minus `exclude` globs into the set to embed.
 * `node_modules` is never descended into: packages are the sidecar's business.
 *
 * @param {{ root: string, include: string[], exclude?: string[] }} input
 * @returns {{
 *   root: string,
 *   entrypoints: string[],
 *   relpaths: string[],
 *   report: { excluded: string[], nonModule: string[], unmatched: string[] },
 * }}
 */
export function planEmbed({ root, include, exclude = [] }) {
  const base = resolve(root);
  const found = new Set();
  const unmatched = [];
  for (const pattern of include) {
    const before = found.size;
    if (GLOB_META.test(pattern)) {
      for (const rel of new Bun.Glob(pattern).scanSync({ cwd: base, onlyFiles: true })) {
        const posix = toPosix(rel);
        if (!posix.split('/').includes('node_modules')) found.add(posix);
      }
    } else {
      const abs = resolve(base, pattern);
      const rel = relative(base, abs);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`compile-embed: '${pattern}' is outside the embed root ${base}`);
      }
      if (!existsSync(abs))
        throw new Error(`compile-embed: '${pattern}' does not exist under ${base}`);
      if (statSync(abs).isDirectory()) {
        if (!rel.split(sep).includes('node_modules')) {
          const files = [];
          walkFiles(abs, base, files);
          for (const f of files) found.add(f);
        }
      } else {
        found.add(toPosix(rel));
      }
    }
    if (found.size === before && ![...found].some((f) => f === toPosix(pattern)))
      unmatched.push(pattern);
  }

  const excludeGlobs = exclude.map((g) => new Bun.Glob(g));
  const excluded = [];
  const nonModule = [];
  const byEmbedded = new Map();
  for (const rel of [...found].sort()) {
    if (excludeGlobs.some((g) => g.match(rel))) {
      excluded.push(rel);
      continue;
    }
    if (!MODULE_EXT.test(rel)) {
      nonModule.push(rel);
      continue;
    }
    const target = embeddedPath(rel);
    const other = byEmbedded.get(target);
    if (other) {
      throw new Error(
        `compile-embed: '${other}' and '${rel}' would both embed at $bunfs/root/${target}`,
      );
    }
    byEmbedded.set(target, rel);
  }
  const relpaths = [...byEmbedded.keys()].sort();
  return {
    root: base,
    entrypoints: relpaths.map((r) => join(base, byEmbedded.get(r))),
    relpaths,
    report: { excluded, nonModule, unmatched },
  };
}

/**
 * The `Bun.build` options that embed `plan` beside `entry`. `entry` must live
 * under the plan's root, or its own embedded path — and every relative path
 * computed from it — shifts.
 *
 * @param {ReturnType<typeof planEmbed>} plan
 * @param {{ entry: string, outfile: string, includeSupported: boolean, format?: "esm" | "cjs",
 *           bytecode?: boolean, minify?: boolean, target?: string, extra?: Record<string, unknown> }} opts
 */
export function embedBuildOptions(plan, opts) {
  const rel = relative(plan.root, resolve(opts.entry));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`compile-embed: entry ${opts.entry} is outside the embed root ${plan.root}`);
  }
  const compile = { outfile: opts.outfile };
  let entrypoints = [resolve(opts.entry)];
  if (opts.includeSupported) {
    compile.include = plan.entrypoints;
  } else {
    // @knext-shim embed-extra-entrypoints
    entrypoints = [...entrypoints, ...plan.entrypoints];
  }
  return {
    ...opts.extra,
    entrypoints,
    root: plan.root,
    naming: '[dir]/[name].[ext]',
    target: opts.target ?? 'bun',
    format: opts.format ?? 'esm',
    bytecode: opts.bytecode ?? false,
    minify: opts.minify ?? false,
    compile,
  };
}

/**
 * Call first thing in a compiled entry. With `KNEXT_EMBED_PROBE` set to a JSON
 * list of relpaths, reports which are NOT at `$bunfs/root/<relpath>` (both
 * present in the embedded filesystem and resolvable by `require.resolve`) and
 * exits; otherwise does nothing.
 */
export function runEmbedProbe(env = process.env) {
  const raw = env[EMBED_PROBE_ENV];
  if (!raw) return;
  const root = dirname(process.argv[1]);
  const req = createRequire(join(root, '__probe__.js'));
  const missing = [];
  for (const rel of JSON.parse(raw)) {
    const abs = join(root, rel);
    let ok = existsSync(abs);
    if (ok) {
      try {
        ok = req.resolve(abs) === abs;
      } catch {
        ok = false;
      }
    }
    if (!ok) missing.push(rel);
  }
  process.stdout.write(`${PROBE_LINE}${JSON.stringify({ root, missing })}\n`);
  process.exit(0);
}

/**
 * Run `binaryPath` (an entry that calls `runEmbedProbe`) from a fresh EMPTY
 * directory and report which `relpaths` it cannot resolve inside itself.
 * Throws when the binary does not answer the probe at all.
 *
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function assertPathFidelity(binaryPath, relpaths) {
  const cwd = mkdtempSync(join(tmpdir(), 'knext-embed-probe-'));
  try {
    const r = spawnSync(binaryPath, [], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '',
        TMPDIR: cwd,
        [EMBED_PROBE_ENV]: JSON.stringify(relpaths),
      },
    });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith(PROBE_LINE));
    if (!line) {
      throw new Error(
        `compile-embed: ${binaryPath} did not answer the embed probe (exit ${r.status}) — its entry must call runEmbedProbe():\n${`${r.stdout}${r.stderr}`.slice(0, 800)}`,
      );
    }
    const { missing } = JSON.parse(line.slice(PROBE_LINE.length));
    return { ok: missing.length === 0, missing };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Modules under `serverOutputDir` whose require/import target is computed at
 * runtime, so no plan can know what they load: `computedSites` counts
 * `require(x)` / `import(x)` with a non-literal argument (computed-require-scan),
 * `dynamicRequireBindings` names `createRequire(import.meta.url)` bindings called
 * with a non-literal (the rolldown `__require(name)` shape — vinext-compile's
 * `planRuntimeRequires` "dynamic" class). `planRuntimeRequires` itself is not
 * importable: vinext-compile.mjs is a script that parses argv and builds at
 * module load, so this reuses the two side-effect-free analyses it is built on.
 *
 * @param {string} serverOutputDir
 * @returns {{ file: string, computedSites: number, dynamicRequireBindings: string[] }[]}
 */
export function unembeddedDynamicReport(serverOutputDir) {
  const base = resolve(serverOutputDir);
  const files = [];
  walkFiles(base, base, files);
  const rows = [];
  for (const rel of files.sort()) {
    if (!/\.[cm]?js$/.test(rel)) continue;
    const src = readFileSync(join(base, rel), 'utf8');
    const computedSites = computedRequireSites(src).length;
    const analysis = analyzeServerModule(src);
    const dynamicRequireBindings = analysis.requireBindings
      .filter((b) => analysis.nonLiteralCallees.has(b))
      .sort();
    if (computedSites > 0 || dynamicRequireBindings.length > 0)
      rows.push({ file: rel, computedSites, dynamicRequireBindings });
  }
  return rows;
}

let includeDetection;

/**
 * Does the pinned Bun embed a DIRECTORY through `Bun.build({ compile: { include } })`
 * (oven-sh/bun#44059)? Answered by a real compile: a directory is included,
 * the source tree is deleted, and the binary — run from an empty directory —
 * must load a computed `import()` from it. Cached per process.
 *
 * @returns {Promise<{ supported: boolean, evidence: string }>}
 */
export function detectCompileInclude() {
  includeDetection ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-include-detect-'));
    try {
      const src = join(dir, 'src');
      mkdirSync(join(src, 'plugins'), { recursive: true });
      writeFileSync(join(src, 'plugins', 'p.js'), 'export default "plugin-ok";\n');
      writeFileSync(
        join(src, 'main.mjs'),
        'const n = process.env.PLUGIN || "p";\n' +
          'try { const m = await import("./plugins/" + n + ".js"); console.log("RESULT " + m.default); }\n' +
          'catch (e) { console.log("RESULT fail " + String(e.message).split("\\n")[0]); }\n',
      );
      const outfile = join(dir, 'run', 'app');
      let built;
      try {
        built = await Bun.build({
          entrypoints: [join(src, 'main.mjs')],
          root: src,
          target: 'bun',
          compile: { outfile, include: [join(src, 'plugins')] },
        });
      } catch (e) {
        return {
          supported: false,
          evidence: `Bun.build rejected compile.include: ${String(e?.message ?? e).split('\n')[0]}`,
        };
      }
      if (!built.success) {
        return {
          supported: false,
          evidence: `compile failed: ${built.logs.map(String).join(' | ')}`,
        };
      }
      rmSync(src, { recursive: true, force: true });
      const r = spawnSync(outfile, [], {
        cwd: dirname(outfile),
        encoding: 'utf8',
        timeout: 60_000,
      });
      const line =
        (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT ')) ??
        `(no RESULT, exit ${r.status})`;
      return {
        supported: line === 'RESULT plugin-ok',
        evidence: `Bun ${Bun.version}: directory via compile.include → ${line}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return includeDetection;
}
