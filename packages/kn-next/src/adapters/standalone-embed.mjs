/**
 * Self-contained mode for the compiled standalone executable (#1456): the
 * pieces that put `.next/server/**`, the manifests and the modules route chunks
 * load from `node_modules` INTO the binary, so it boots with nothing beside it
 * but `public/`, `.next/static/` and (for sharp) `native/`.
 *
 * Measured on stock Bun 1.4.2 (darwin-arm64), each one shaping a rule below:
 *
 *   - a module passed as an extra entrypoint is embedded at
 *     `$bunfs/root/<relpath>` and `require(<that absolute path>)` loads it;
 *   - a module's own static imports are BUNDLED INTO it unless external — so a
 *     Next singleton (`*.external`, the async-storage instances) required by
 *     two embedded chunks would load twice. Every import from an embedded
 *     module that resolves to another embedded module is therefore made
 *     external, rewritten to the RELATIVE path between their embedded
 *     locations: measured, two chunks then share one instance;
 *   - a BARE specifier required from an embedded module does not resolve
 *     inside `$bunfs` at all (not even with the package's `package.json`
 *     embedded and `autoloadPackageJson` on) — the relative rewrite above is
 *     what makes literal bare requires work;
 *   - `__dirname` / `__filename` in an embedded CommonJS module are inlined as
 *     the BUILD directory (oven-sh/bun#44068) and `module.filename` is wrong
 *     too; a module that binds them as function parameters is left alone by the
 *     bundler, so they are rebound to the embedded path (`rebindDirnameSource`);
 *   - a file imported `with { type: "file" }` under the asset naming
 *     `[dir]/[name].[ext]` is readable with `fs` at `$bunfs/root/<relpath>`,
 *     byte for byte — which is how Next's `fs`-read files (JSON manifests, the
 *     `*manifest.js` files it evaluates in a `vm`, the edge-runtime files, the
 *     prerendered `.html`/`.rsc`/`.meta`/`.body`) are embedded. An extensionless
 *     file gets a trailing dot (`BUILD_ID` → `BUILD_ID.`), aliased at runtime;
 *   - `fs.createReadStream` of an embedded file fails (oven-sh/bun#22223), so
 *     `.next/static` stays on disk and is aliased there, not embedded.
 *
 * Dependency-free over node builtins: the compile script bundles it, and the
 * alias installer is serialised into the entry with `Function#toString`.
 */
import { posix } from 'node:path';

/** The global the entry prologue sets to the embedded filesystem root. */
export const EMBED_ROOT_GLOBAL = '__knextEmbedRoot';

/** Extensions a `.next` file may carry and still be a known kind (embedded as data). */
const KNOWN_DATA_KINDS = new Set([
  'json',
  'html',
  'rsc',
  'meta',
  'body',
  'txt',
  'map',
  'segment',
  'prefetch',
  // Next reads a `.wasm` (edge-runtime WASM modules) with `fs`, the same as the
  // other data kinds above — never `require`s it as a native addon. Embedding it
  // byte-for-byte via the `assets` path is therefore correct, so it is a KNOWN
  // kind rather than falling into `unknownKinds` (whose only guarantee is "some
  // fs-read data path", not "this specific kind is safe to embed").
  'wasm',
  '',
]);

/** A native addon: dlopen's a real file on disk. `$bunfs` cannot provide one. */
const NATIVE_ADDON = /\.node$/;

/** A `*.js` under `.next` that Next reads with `fs` (evalManifest), never `require`s. */
const FS_READ_JS = /(?:^|[-_/])[a-z-]*manifest\.js$/;

const MODULE_JS = /\.(?:c|m)?js$/;

function extensionOf(rel) {
  const base = posix.basename(rel);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1);
}

/**
 * Split every file under the app's `.next` (paths relative to it, posix) into
 * what the executable embeds and how:
 *
 *   - `modules` — JavaScript Next `require`s (route chunks, the webpack /
 *     turbopack runtimes, `instrumentation.js`): compiled, bytecode;
 *   - `assets` — everything Next reads with `fs`: manifests (JSON, and the
 *     `*manifest.js` it evaluates as text), the edge-runtime files the
 *     middleware manifest lists (the edge sandbox reads them as text), and the
 *     prerendered outputs. Embedded byte for byte;
 *   - `disk` — `static/**` and `cache/**`, which stay beside the binary
 *     (served with `createReadStream`, and written at runtime);
 *   - `nativeAddons` — a `.node` file. NEVER embedded: a native addon is
 *     `dlopen`'d from a real filesystem path, which `$bunfs` cannot provide,
 *     so embedding one as data would ship a file Next's `require` can only
 *     crash on. The caller must fail the build rather than embed these
 *     (`standalone-compile.mjs`'s self-contained planning step does);
 *   - `unknownKinds` — assets whose extension is not a kind this classifier
 *     knows. They ARE embedded (as data); the list makes a new Next output
 *     kind visible instead of silently guessing its read path.
 *
 * Nothing is dropped: `modules + assets + disk + nativeAddons` is exactly the
 * input (a `.node` file is counted in `nativeAddons` only, never `assets`).
 *
 * @param {readonly string[]} relFiles
 * @param {{ edgeFiles?: Iterable<string> }} [opts] files listed by
 *   `server/middleware-manifest.json` (paths relative to `.next`)
 */
export function classifyDistFiles(relFiles, { edgeFiles = [] } = {}) {
  const edge = new Set(edgeFiles);
  const modules = [];
  const assets = [];
  const disk = [];
  const unknownKinds = [];
  const nativeAddons = [];
  for (const rel of [...relFiles].sort()) {
    const top = rel.split('/')[0];
    if (top === 'static' || top === 'cache') {
      disk.push(rel);
    } else if (
      MODULE_JS.test(rel) &&
      rel.startsWith('server/') &&
      !FS_READ_JS.test(rel) &&
      !edge.has(rel)
    ) {
      modules.push(rel);
    } else if (NATIVE_ADDON.test(rel)) {
      nativeAddons.push(rel);
    } else {
      assets.push(rel);
      const ext = extensionOf(rel);
      if (!MODULE_JS.test(rel) && !KNOWN_DATA_KINDS.has(ext)) unknownKinds.push(rel);
    }
  }
  return { modules, assets, disk, unknownKinds, nativeAddons };
}

/** Every `files` entry of a middleware manifest (middleware + edge functions). */
export function middlewareManifestFiles(manifest) {
  const out = new Set();
  for (const group of [manifest?.middleware, manifest?.functions]) {
    for (const fn of Object.values(group ?? {})) {
      for (const f of fn?.files ?? []) out.add(f);
    }
  }
  return [...out].sort();
}

/**
 * The specifier an embedded module at `fromRel` uses to reach the embedded
 * module at `toRel` (both relative to the embed root, posix): always relative,
 * so it resolves inside `$bunfs` without a package lookup.
 */
export function relativeSpecifier(fromRel, toRel) {
  const rel = posix.relative(posix.dirname(fromRel), toRel);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

const DIRNAME_REF = /\b__(?:dirname|filename)\b/;
const ESM_SYNTAX = /^\s*(?:import\s*[\s{*"'`]|export\s)/m;

/**
 * Rebind `__dirname` / `__filename` of an embedded CommonJS module to its
 * embedded location, read from the embed-root global at load time. A no-op for
 * a module that references neither, and for ESM (which has no such bindings).
 * `this` (the module's `exports`) is preserved.
 *
 * @param {string} src the module source
 * @param {string} embeddedRel its path under the embed root (posix)
 */
// @upstream-shim bun-cjs-dirname-rebind
export function rebindDirnameSource(src, embeddedRel) {
  if (!DIRNAME_REF.test(src) || ESM_SYNTAX.test(src)) return src;
  const dir = JSON.stringify(`/${posix.dirname(embeddedRel)}`.replace(/\/\.$/, ''));
  const file = JSON.stringify(`/${embeddedRel}`);
  const root = `globalThis.${EMBED_ROOT_GLOBAL}`;
  return `(function (__dirname, __filename) {\n${src}\n}).call(this, ${root} + ${dir}, ${root} + ${file});\n`;
}

/**
 * Redirect `fs` calls on `aliases` (exact path or directory prefix → target)
 * before they reach the filesystem. Installed by the self-contained entry, so
 * that Next — which derives `.next/static` and `.next/cache` from `distDir` —
 * reads its build output from the executable while serving static files from,
 * and writing its cache to, the disk beside it; and so an extensionless
 * embedded file is found under the name Bun gave it.
 *
 * Serialised into the entry with `toString()`: it must stay self-contained
 * (no closure over this module).
 *
 * @param {Record<string, any>} fs `node:fs`
 * @param {Record<string, any>} fsp `node:fs/promises`
 * @param {Record<string, string>} aliases
 */
// @upstream-shim bunfs-static-disk-alias
export function installDistDirAlias(fs, fsp, aliases) {
  const entries = Object.entries(aliases).sort((a, b) => b[0].length - a[0].length);
  const map = (p) => {
    if (typeof p !== 'string') return p;
    for (const [from, to] of entries) {
      if (p === from) return to;
      if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
    }
    return p;
  };
  const ONE = [
    'access',
    'appendFile',
    'chmod',
    'createReadStream',
    'createWriteStream',
    'exists',
    'lstat',
    'mkdir',
    'open',
    'opendir',
    'readdir',
    'readFile',
    'readlink',
    'realpath',
    'rm',
    'rmdir',
    'stat',
    'truncate',
    'unlink',
    'utimes',
    'writeFile',
  ];
  const TWO = ['copyFile', 'cp', 'rename'];
  const wrap = (obj, name, arity) => {
    const orig = obj?.[name];
    if (typeof orig !== 'function' || orig.__knextAliased) return;
    const wrapped = function (...args) {
      args[0] = map(args[0]);
      if (arity === 2) args[1] = map(args[1]);
      return orig.apply(this, args);
    };
    wrapped.__knextAliased = true;
    if (orig.native) wrapped.native = orig.native;
    obj[name] = wrapped;
  };
  for (const name of ONE) {
    wrap(fs, name, 1);
    wrap(fs, `${name}Sync`, 1);
    wrap(fsp, name, 1);
    if (fs.promises && fs.promises !== fsp) wrap(fs.promises, name, 1);
  }
  for (const name of TWO) {
    wrap(fs, name, 2);
    wrap(fs, `${name}Sync`, 2);
    wrap(fsp, name, 2);
    if (fs.promises && fs.promises !== fsp) wrap(fs.promises, name, 2);
  }
  return map;
}

/**
 * `require()` of an embedded JSON FILE (a `type: "file"` asset) evaluates its
 * text as JavaScript on Bun 1.4.2 — a SyntaxError on the first `:`. Next
 * `require`s some manifests by absolute path (`middleware-manifest.json`), so
 * such requests are answered from the file's bytes, parsed once and cached
 * like a real `require`. Only absolute `.json` paths under the embedded root
 * are touched.
 *
 * Serialised into the entry with `toString()`: it must stay self-contained.
 *
 * @param {any} Module `node:module`
 * @param {any} fs `node:fs`
 * @param {string} root the embedded root (`/$bunfs/root`)
 */
// @upstream-shim bun-json-asset-require
export function installEmbeddedJsonRequire(Module, fs, root) {
  const prefix = `${root}/`;
  const orig = Module.prototype.require;
  const cache = new Map();
  Module.prototype.require = function (id) {
    if (typeof id === 'string' && id.startsWith(prefix) && id.endsWith('.json')) {
      if (!cache.has(id)) cache.set(id, JSON.parse(fs.readFileSync(id, 'utf8')));
      return cache.get(id);
    }
    return orig.apply(this, arguments);
  };
}

/**
 * Turbopack names each server-external package by a hashed alias
 * (`pg-61b435ba5261e5d7`), a symlink in `.next/node_modules`, and its runtime
 * loads an ESM external with a COMPUTED `import(alias)` — a bare specifier,
 * which never resolves inside `$bunfs`. Every quoted occurrence of an alias in
 * an embedded module is replaced with the absolute embedded path of the file it
 * resolves to (built from the embed-root global at load time), so the runtime's
 * `import()` / `require()` receives a path it can load.
 *
 * A quoted `"<alias>/<subpath>"` is not rewritten: it is reported so the caller
 * can refuse the build rather than ship a specifier that cannot resolve.
 *
 * @param {string} src the module source
 * @param {ReadonlyMap<string, string>} aliases alias → embedded path of its entry (posix, under the root)
 * @returns {{ source: string, rewritten: number, unresolvedSubpaths: string[] }}
 */
// @upstream-shim embedded-bare-specifier
export function rewriteExternalAliases(src, aliases) {
  let source = src;
  let rewritten = 0;
  const unresolvedSubpaths = [];
  for (const [alias, rel] of aliases) {
    if (!source.includes(alias)) continue;
    const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of source.matchAll(new RegExp(`(["'\`])${esc}/[^"'\`]*\\1`, 'g'))) {
      unresolvedSubpaths.push(m[0]);
    }
    source = source.replace(new RegExp(`(["'\`])${esc}\\1`, 'g'), () => {
      rewritten++;
      return `(globalThis.${EMBED_ROOT_GLOBAL} + ${JSON.stringify(`/${rel}`)})`;
    });
  }
  return { source, rewritten, unresolvedSubpaths };
}
