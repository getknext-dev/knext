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
 *     directory (oven-sh/bun#44068, fixed by oven-sh/bun#29066). A CommonJS
 *     module that anchors a computed require on `__dirname` therefore does not
 *     resolve from an empty directory; a RELATIVE computed require
 *     (`require("./" + n)`) does. Delete this constraint once the
 *     `bun-cjs-dirname-inlined` retirement probe goes red.
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
// @upstream-shim bun-cjs-dirname-inlined
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
    // A path that exists is a literal even when it holds glob metacharacters:
    // Next names files `[id]/page.js`, `[root-of-the-server]__x.js`,
    // `[turbopack]_runtime.js` — read as globs, they match nothing.
    if (GLOB_META.test(pattern) && !existsSync(resolve(base, pattern))) {
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
    // @upstream-shim embed-extra-entrypoints
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

/** One detection compile: its label, how it embeds `plugins/p.js`, and the expected outcome. */
const INCLUDE_FORMS = /** @type {const} */ ({
  // Probes — the shapes oven-sh/bun#44059 adds.
  jsFiles: 'Bun.build compile.include = [file] (the embedBuildOptions shape)',
  jsDir: 'Bun.build compile.include = [directory]',
  cliDir: '`bun build --compile --include=<directory>`',
});

function classifyIncludeRun(line) {
  if (line === 'RESULT plugin-ok') return 'embedded';
  if (/^RESULT fail Cannot find module '\.\/plugins\/p\.js'/.test(line)) return 'not-embedded';
  return 'odd';
}

/**
 * Does the pinned Bun embed through `compile.include` (oven-sh/bun#44059)?
 * Answered by real compiles of one fixture — an entry that computes
 * `import("./plugins/" + n + ".js")` — run from an empty directory after the
 * source tree is deleted:
 *
 *   - CONTROL (positive): the plugin passed as an extra entrypoint (the stock
 *     fallback) must load — proves compile + run + the oracle work here;
 *   - CONTROL (negative): no include, no extra entrypoint, must NOT load —
 *     proves the binary does not read the deleted source from disk;
 *   - PROBES: `compile.include` as a FILE list (what `embedBuildOptions`
 *     passes), as a DIRECTORY, and the CLI `--include=<dir>`.
 *
 * `supported` (what a build uses) is the file-list form alone. `landed` is true
 * when ANY probe form embeds, so a CLI-only or directory-only landing is not
 * missed by the retirement harness. `conclusive` is false when a control fails
 * or a probe neither embeds nor cleanly misses (a rejected build, a crash): the
 * caller must not read that as "not supported" OR "supported". Cached per
 * process.
 *
 * @returns {Promise<{ supported: boolean, landed: boolean, conclusive: boolean,
 *   forms: Record<string, string>, evidence: string }>}
 */
export function detectCompileInclude() {
  includeDetection ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-include-detect-'));
    const forms = {};
    const fail = (why) => ({
      supported: false,
      landed: false,
      conclusive: false,
      forms,
      evidence: `Bun ${Bun.version}: inconclusive — ${why}`,
    });
    try {
      const src = join(dir, 'src');
      mkdirSync(join(src, 'plugins'), { recursive: true });
      const plugin = join(src, 'plugins', 'p.js');
      writeFileSync(plugin, 'export default "plugin-ok";\n');
      writeFileSync(
        join(src, 'main.mjs'),
        'const n = process.env.PLUGIN || "p";\n' +
          'try { const m = await import("./plugins/" + n + ".js"); console.log("RESULT " + m.default); }\n' +
          'catch (e) { console.log("RESULT fail " + String(e.message).split("\\n")[0]); }\n',
      );
      const entry = join(src, 'main.mjs');
      const outOf = (name) => join(dir, `out-${name}`, 'app');
      const jsBuild = async (name, extraEntries, include) => {
        const compile = { outfile: outOf(name) };
        if (include) compile.include = include;
        try {
          const built = await Bun.build({
            entrypoints: [entry, ...extraEntries],
            root: src,
            target: 'bun',
            naming: '[dir]/[name].[ext]',
            compile,
          });
          return built.success ? null : `build failed: ${built.logs.map(String).join(' | ')}`;
        } catch (e) {
          return `Bun.build threw: ${String(e?.message ?? e).split('\n')[0]}`;
        }
      };
      const buildErrors = {
        controlExtra: await jsBuild('controlExtra', [plugin]),
        controlNone: await jsBuild('controlNone', []),
        jsFiles: await jsBuild('jsFiles', [], [plugin]),
        jsDir: await jsBuild('jsDir', [], [join(src, 'plugins')]),
      };
      // `--include=<v>`: stock Bun ignores the unknown `=` form and still builds,
      // while `--include <v>` would make the directory a positional entry point.
      const cli = spawnSync(
        process.execPath,
        ['build', '--compile', './main.mjs', '--include=./plugins', '--outfile', outOf('cliDir')],
        { cwd: src, encoding: 'utf8', timeout: 120_000 },
      );
      buildErrors.cliDir =
        cli.status === 0
          ? null
          : `CLI exit ${cli.status}: ${`${cli.stderr ?? ''}`.trim().split('\n')[0]}`;

      rmSync(src, { recursive: true, force: true });
      const empty = join(dir, 'empty');
      mkdirSync(empty);
      const runOf = (name) => {
        if (buildErrors[name]) return `rejected (${buildErrors[name]})`;
        const r = spawnSync(outOf(name), [], {
          cwd: empty,
          encoding: 'utf8',
          timeout: 60_000,
          env: { PATH: process.env.PATH ?? '', TMPDIR: dir },
        });
        const line =
          (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT ')) ??
          `(no RESULT, exit ${r.status}${r.error ? `, ${r.error.message}` : ''})`;
        return `${classifyIncludeRun(line)} (${line})`;
      };

      const controlExtra = runOf('controlExtra');
      const controlNone = runOf('controlNone');
      const controls = `control extra-entrypoint → ${controlExtra}; control no-embed → ${controlNone}`;
      if (!controlExtra.startsWith('embedded ')) return fail(`positive control: ${controls}`);
      if (!controlNone.startsWith('not-embedded ')) return fail(`negative control: ${controls}`);

      for (const name of Object.keys(INCLUDE_FORMS)) forms[name] = runOf(name);
      const outcome = (name) => forms[name].split(' ')[0];
      const landed = Object.keys(INCLUDE_FORMS).some((n) => outcome(n) === 'embedded');
      const conclusive =
        landed || Object.keys(INCLUDE_FORMS).every((n) => outcome(n) === 'not-embedded');
      const evidence =
        `Bun ${Bun.version}: ${controls}; ` +
        Object.entries(INCLUDE_FORMS)
          .map(([n, label]) => `${label} → ${forms[n]}`)
          .join('; ');
      return {
        supported: outcome('jsFiles') === 'embedded',
        landed,
        conclusive,
        forms,
        evidence: conclusive ? evidence : `inconclusive — ${evidence}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return includeDetection;
}
