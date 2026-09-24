/**
 * Compile a Next.js `output: 'standalone'` server into a Bun single executable,
 * WITH `--bytecode` — the build for the standalone-on-Bun runtime cell.
 *
 * Run under bun, by `kn-next build`:
 *
 *   bun run standalone-compile.mjs --server <.next/standalone/…/server.js> \
 *                                  --outfile <path> [--root <.next/standalone>] \
 *                                  [--target <bun triple>]
 *
 * `--root` is the `.next/standalone` directory. In a monorepo `server.js` sits
 * deeper (`standalone/apps/<app>/server.js`) while the traced node_modules sit
 * at the root; it defaults to the directory of `--server`.
 *
 * ## What gets compiled, and what stays on disk
 *
 * The entry is Next's own generated `server.js` (with its `__dirname` anchor
 * rewritten, below). Everything it reaches STATICALLY — `next/dist/server/**`,
 * the request pipeline, the router, the render entry points — is bundled and
 * compiled to bytecode. What Next loads by COMPUTED path at request time stays
 * on disk beside the binary, exactly where `next build` put it: the route
 * chunks under `.next/server/**`, the prebuilt `*.runtime.prod.js` renderers
 * the chunks `require` as externals, and the manifests. So the binary does not
 * replace the standalone tree; it replaces `bun server.js`.
 *
 * ## The flag that makes it work: `autoloadPackageJson`
 *
 * A Bun `--compile` executable does not read `package.json` files at runtime by
 * default. Code loaded from DISK (the route chunks above) then cannot resolve a
 * single bare specifier — `require('next/dist/compiled/source-map')`,
 * `require('@swc/helpers/_/_interop_require_default')` — because resolving a
 * package means reading its manifest. Relative and absolute requires still
 * work, which is why this looked like an unfixable "Bun can't resolve from
 * disk" wall. `compile.autoloadPackageJson: true` (CLI:
 * `--compile-autoload-package-json`) turns manifest reading back on, and
 * Node-style resolution from disk-loaded modules works again. Measured: the
 * same build without it fails every app route with exactly those errors.
 *
 * ## Why this is a script and not `bun build --compile --bytecode`
 *
 * `bun build` has no `--plugin`, and the graph needs a resolver with three
 * duties (`standaloneResolver` below):
 *
 *   - Next's dev-only modules (`next-dev-server`, the dev bundler, the dev
 *     overlay, `*.development.js`) are reachable from `server.js` through
 *     requires guarded by `dev` flags the bundler cannot prove dead. They are
 *     replaced with an empty module. Production never takes those branches —
 *     `server.js` hard-codes `isDev: false`.
 *   - The graph is CONFINED to the traced tree. A module that resolves outside
 *     `.next/standalone` (the build machine's own node_modules), or not at all,
 *     stays a runtime require — exactly what the uncompiled server would do.
 *   - Target `bun` selects a package's `"bun"` export condition. `next build`
 *     traces under Node, so a `"bun"` target (react-dom's `server.bun.js`) may
 *     be missing from the traced tree while the exports map still names it; the
 *     resolver then fails the whole specifier. Such specifiers are re-resolved
 *     under Node's conditions instead — the files `next build` actually traced.
 *
 * The entry rewrite itself (both `server.js` shapes, CommonJS and the ESM one
 * Next emits for a `"type": "module"` app) lives in `standalone-exec-entry.mjs`.
 *
 * ## Baked-in preloads
 *
 * The uncompiled cell runs `bun --require cache-control-normalize.cjs
 * --require bun-keepalive-guard.cjs server.js`. A compiled executable takes no
 * `--require`, so both preloads are the entry's first two statements instead:
 * the compiled cell serves the same Cache-Control shape the compat suite gates.
 *
 * ## The bytecode proof
 *
 * After compiling, the executable is scanned (`bytecode-exec-verify.mjs`) for
 * the entry marker injected below, and the build FAILS unless the entry was
 * compiled to bytecode. A missing bytecode flag would otherwise ship a binary
 * that boots fine and is merely slow.
 */
import { randomBytes } from "node:crypto";
import {
    existsSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBytecodeExec } from "./bytecode-exec-verify.mjs";
import { computedRequireInventory } from "./computed-require-scan.mjs";
import {
    DEV_ONLY_STUB_SOURCE,
    resolveExportsUnderNode,
    splitBareSpecifier,
    standaloneCacheHandlerFiles,
    standaloneExecEntrySource,
} from "./standalone-exec-entry.mjs";

/** `--flag value` pairs; no positional arguments. */
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        if (!key?.startsWith("--")) continue;
        out[key.slice(2)] = argv[i + 1];
    }
    return out;
}

function fail(message) {
    console.error(`[knext standalone-compile] ${message}`);
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.server) fail("--server <path to the standalone server.js> is required");
if (!args.outfile) fail("--outfile <path> is required");
const SERVER = resolve(args.server);
const OUTFILE = resolve(args.outfile);
const TARGET = args.target?.trim();

if (!existsSync(SERVER)) {
    fail(`no standalone server at ${SERVER} — run \`next build\` with output: 'standalone' first`);
}
// The `.next/standalone` root. In a monorepo server.js sits deeper
// (`standalone/apps/<app>/server.js`) while the traced node_modules sit at the
// root, so the root is passed explicitly; it defaults to server.js's directory.
const ROOT = realpathSync(resolve(args.root ?? dirname(SERVER)));
if (!isInside(realpathSync(SERVER), ROOT)) {
    fail(`--root ${ROOT} does not contain ${SERVER}`);
}

// Preloads: shipped beside this script (dist: tsup emits them as .cjs; the
// source tree has them under the same names).
const here = dirname(fileURLToPath(import.meta.url));
const PRELOADS = ["cache-control-normalize.cjs", "bun-keepalive-guard.cjs"].map((f) => join(here, f));
for (const p of PRELOADS) {
    if (!existsSync(p)) {
        fail(`preload ${p} is missing beside the compile script — refusing to compile a server without it`);
    }
}

// ── The entry: Next's server.js, re-anchored (standalone-exec-entry.mjs) ────
let entrySource;
try {
    entrySource = standaloneExecEntrySource(readFileSync(SERVER, "utf8"), PRELOADS);
} catch (err) {
    fail(err instanceof Error ? err.message : String(err));
}
const entry = join(dirname(SERVER), ".knext-standalone-exec-entry.cjs");
writeFileSync(entry, entrySource);

// The bytecode-proof marker: unique per build, so a stale binary cannot pass.
// `kn-next build` passes its own (and re-verifies the artifact itself).
const MARKER = args.marker ?? `knext-standalone-exec:${randomBytes(12).toString("hex")}`;
if (!/^knext-standalone-exec:[0-9a-f]{24}$/.test(MARKER)) {
    fail(`--marker must be knext-standalone-exec:<24 hex chars>, got ${JSON.stringify(MARKER)}`);
}

// Test-only: compile WITHOUT bytecode to prove the verifier below rejects it on
// a real app. It can never yield an artifact — the verifier deletes the file
// and the script exits 1 — so it is not a way to ship an unverified binary.
const NO_BYTECODE_FOR_VERIFIER_TEST =
    process.env.KNEXT_STANDALONE_COMPILE_NO_BYTECODE_FOR_VERIFIER_TEST === "1";

// ── Plugins ──────────────────────────────────────────────────────────────────
const EMPTY = join(dirname(SERVER), ".knext-standalone-exec-empty.cjs");
// Throws on USE (see DEV_ONLY_STUB_SOURCE in standalone-exec-entry.mjs).
writeFileSync(EMPTY, DEV_ONLY_STUB_SOURCE);

/** Dev-only modules production `server.js` (isDev: false) never executes. */
const DEV_ONLY = [
    /next-dev-server/,
    /setup-dev-bundler/,
    /next-devtools/,
    /hot-reloader/,
    /\.development\.js$/,
];

/**
 * Walk up from `fromDir` to the package directory for a bare specifier, NEVER
 * leaving the standalone tree. The traced tree is the whole truth about what
 * ships: a package found above it (the project's own node_modules) is one the
 * image will not have, so it must not be bundled from there either.
 */
function findPackageDir(name, fromDir) {
    let dir = realpathSync(fromDir);
    while (isInside(dir, ROOT)) {
        const candidate = join(dir, "node_modules", name);
        if (existsSync(join(candidate, "package.json"))) {
            const real = realpathSync(candidate);
            return isInside(real, ROOT) ? real : undefined;
        }
        const up = dirname(dir);
        if (up === dir) return undefined;
        dir = up;
    }
    return undefined;
}

function isInside(path, root) {
    return path === root || path.startsWith(`${root}/`);
}

const PRELOAD_SET = new Set(PRELOADS);

/** `next`, `@swc/helpers/_/x` — not `./x`, `/abs`, or a builtin. */
function isBareSpecifier(spec) {
    return /^(@[^/]+\/)?[^./][^/]*(\/.*)?$/.test(spec) && !isBuiltin(spec);
}

/**
 * Re-resolve a bare specifier under Node's export conditions inside the
 * standalone tree (the `"bun"`-condition-not-traced case in the header).
 */
function nodeConditionTarget(spec, fromDir) {
    const { name, subpath } = splitBareSpecifier(spec);
    const pkgDir = findPackageDir(name, fromDir);
    if (!pkgDir) return undefined;
    let pkg;
    try {
        pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    } catch {
        return undefined;
    }
    if (!pkg.exports) return undefined;
    const target = resolveExportsUnderNode(pkg.exports, subpath);
    if (!target) return undefined;
    const abs = join(pkgDir, target);
    return existsSync(abs) ? abs : undefined;
}

// ── The disk closure: modules the bundled server must SHARE with disk code ──
// Next loads each route's compiled chunk from `.next/server/**` by path at
// request time, and those chunks `require` Next modules from disk — most
// importantly the `*.external` singletons (`no-fallback-error.external`, the
// work/action/after async-storage instances, …) whose IDENTITY must be shared
// with the server core: `err instanceof NoFallbackError` in base-server, and
// every AsyncLocalStorage lookup, compare against ONE module instance. If the
// compile ALSO bundles such a module into the executable, the process holds
// two copies — measured: a `dynamicParams = false` miss answers 500
// ("Internal: NoFallbackError") instead of 404.
//
// So: every module reachable (through literal require/import specifiers) from
// the disk-loaded tree is kept OUT of the bundle and required at runtime from
// its real on-disk path — the same file, and so the same module instance, the
// chunks get. Everything else the server reaches is bundled and compiled to
// bytecode. The scan is conservative by construction: it over-approximates
// what disk code can load (any literal specifier counts, reached or not), and
// over-externalizing only costs bytecode coverage, never correctness.
//
// Next's require-hook is the one COMPUTED redirect disk code goes through: it
// rewrites every `*.shared-runtime` request to
// `route-modules/pages/vendored/contexts/<name>`. Those targets are one-line
// re-exports of the pages runtime (`module.compiled` ->
// `pages(-turbo).runtime.prod.js`), which the chunks require literally, so the
// runtime — and the React contexts it owns — is already in the closure and on
// disk. Measured on a Pages Router app, including a server-external package's
// `useRouter` through that redirect (standalone-pages.docker-e2e.test.ts); the
// scan therefore does not model the hook itself.
const DISK_SPECIFIER =
    /\brequire\(\s*["'`]([^"'`$]+)["'`]\s*\)|\bimport\(\s*["'`]([^"'`$]+)["'`]\s*\)|\bfrom\s*["']([^"']+)["']/g;

function listJs(dir, out = []) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) listJs(p, out);
        else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
    }
    return out;
}

// ── Extra roots: the cache handlers Next loads by path from OUTSIDE .next/server
// A custom `cacheHandler` (and each `cacheHandlers` entry) is disk-loaded code
// too, and nothing under `.next/server` requires it — Next imports it by the
// configured path at runtime. A handler that requires a Next internal no route
// chunk references would otherwise get a SECOND instance of it: the compile
// bundles the core's copy. Measured on a Pages Router app: a handler importing
// `after-task-async-storage.external` got its own AsyncLocalStorage. So every
// configured handler is a root of the scan below. One that is not inside the
// traced tree cannot be scanned — and the image could not load it either — so
// the compile fails rather than ship a closure it knows is incomplete.
function cacheHandlerRoots() {
    let files;
    try {
        files = standaloneCacheHandlerFiles(readFileSync(SERVER, "utf8"), dirname(SERVER));
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
    return files.map((file) => {
        let real;
        try {
            real = realpathSync(file);
        } catch {
            real = undefined;
        }
        if (!real || !isInside(real, ROOT)) {
            fail(
                `the configured cache handler ${file} is not inside the standalone tree ${ROOT} — ` +
                    "its module closure cannot be scanned, so a Next internal it imports could load twice. " +
                    "Configure the handler as a file inside the project so `next build` traces it into .next/standalone.",
            );
        }
        return real;
    });
}
const CACHE_HANDLER_ROOTS = cacheHandlerRoots();

function computeDiskClosure() {
    const seen = new Set();
    const queue = [
        ...listJs(join(dirname(SERVER), ".next", "server")).map((f) => realpathSync(f)),
        ...CACHE_HANDLER_ROOTS,
    ];
    while (queue.length > 0) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        let src;
        try {
            src = readFileSync(file, "utf8");
        } catch {
            continue;
        }
        for (const m of src.matchAll(DISK_SPECIFIER)) {
            const spec = m[1] ?? m[2] ?? m[3];
            if (!spec || isBuiltin(spec) || spec.startsWith("node:") || spec.startsWith("bun:")) continue;
            let resolved;
            try {
                resolved = Bun.resolveSync(spec, dirname(file));
            } catch {
                continue;
            }
            if (!isAbsolute(resolved)) continue;
            const real = realpathSync(resolved);
            if (isInside(real, ROOT) && !seen.has(real)) queue.push(real);
        }
    }
    return seen;
}
const DISK_CLOSURE = computeDiskClosure();

// Where the standalone ROOT sits relative to the executable at runtime: the
// executable lives beside server.js, which in a monorepo is below the root.
const RUNTIME_ROOT_FROM_EXEC_DIR = relative(realpathSync(dirname(SERVER)), ROOT);
const DISK_NAMESPACE = "knext-disk";

/**
 * One resolver for the whole graph:
 *
 *   1. dev-only modules -> the empty module;
 *   2. anything that resolves OUTSIDE the standalone tree -> left as a runtime
 *      require (external). On a build machine the resolver walks up out of
 *      `.next/standalone` into the project's own node_modules and finds files
 *      `next build` deliberately did not trace — e.g. the non-turbopack
 *      `pages.runtime.prod.js`, which drags in `critters`. The image has only
 *      the traced tree, so bundling from outside it would compile code the
 *      uncompiled server could never have loaded;
 *   3. a bare specifier Bun cannot resolve -> retried under Node's conditions;
 *   4. anything in the DISK CLOSURE (above) -> required at runtime from its
 *      real on-disk path, never bundled, so disk chunks and the bundled server
 *      share one module instance.
 */
const keptOnDisk = new Set();
/** Files inside the standalone tree that the executable BUNDLES (not kept on disk). */
const bundledFiles = new Set();

/** A module in the disk closure resolves to its on-disk twin, not the bundle. */
function onDisk(real) {
    if (!DISK_CLOSURE.has(real)) return undefined;
    keptOnDisk.add(real);
    return { path: relative(ROOT, real), namespace: DISK_NAMESPACE };
}

const standaloneResolver = {
    name: "knext-standalone-resolver",
    setup(build) {
        build.onLoad({ filter: /.*/, namespace: DISK_NAMESPACE }, (a) => ({
            // Resolved at RUNTIME against the standalone root beside the
            // executable (banner below). realpath so the module-cache key is
            // the one a disk chunk's own resolution produces.
            contents: `module.exports = require(require("node:fs").realpathSync(require("node:path").join(globalThis.__knextStandaloneRoot, ${JSON.stringify(a.path)})));`,
            loader: "js",
        }));
        build.onResolve({ filter: /.*/ }, (a) => {
            if (DEV_ONLY.some((p) => p.test(a.path))) return { path: EMPTY };
            if (!a.importer || PRELOAD_SET.has(a.path) || isBuiltin(a.path)) return undefined;
            if (a.path.startsWith("bun:") || a.path.startsWith("node:")) return undefined;
            let resolved;
            try {
                resolved = Bun.resolveSync(a.path, dirname(a.importer));
            } catch {
                resolved = undefined;
            }
            if (resolved !== undefined) {
                if (!isAbsolute(resolved)) return undefined;
                const real = realpathSync(resolved);
                if (!isInside(real, ROOT)) return { path: a.path, external: true };
                const disk = onDisk(real);
                if (!disk) bundledFiles.add(real);
                return disk ?? undefined;
            }
            if (isBareSpecifier(a.path)) {
                const fallback = nodeConditionTarget(a.path, dirname(a.importer));
                if (fallback) return onDisk(realpathSync(fallback)) ?? { path: fallback };
                // Not in the traced tree at all (e.g. `critters`, required only
                // when `optimizeCss` is on). The uncompiled server would throw
                // at that require if it were ever reached; a runtime require
                // keeps exactly that behaviour instead of failing the compile.
                return { path: a.path, external: true };
            }
            return undefined;
        });
    },
};

// ── Compile ──────────────────────────────────────────────────────────────────
let result;
try {
    result = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        // --bytecode emits CommonJS; server.js and next/dist/server are CJS.
        format: "cjs",
        bytecode: !NO_BYTECODE_FOR_VERIFIER_TEST,
        minify: true,
        // The bytecode-proof marker, as a BANNER so it sits directly under the
        // module's `// @bun …` pragma rather than after megabytes of bundled
        // Next source (where a stray "// @bun" string could sit in between).
        banner:
            `globalThis.__knextStandaloneExecMarker=${JSON.stringify(MARKER)};` +
            `globalThis.__knextStandaloneRoot=require("node:path").resolve(process.env.KNEXT_STANDALONE_DIR||require("node:path").dirname(process.execPath),${JSON.stringify(RUNTIME_ROOT_FROM_EXEC_DIR)});`,
        plugins: [standaloneResolver],
        // Production branches only: react/next pick their `.production` code
        // at build time and the dev branches are dead-code-eliminated.
        define: {
            "process.env.NODE_ENV": '"production"',
            "process.env.NEXT_RUNTIME": '"nodejs"',
        },
        compile: {
            outfile: OUTFILE,
            // The load-bearing flag — see the header.
            autoloadPackageJson: true,
            ...(TARGET ? { target: TARGET } : {}),
        },
    });
} finally {
    rmSync(entry, { force: true });
    rmSync(EMPTY, { force: true });
}

if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    fail("compile failed");
}

// ── The bytecode proof (fail closed) ────────────────────────────────────────
const verdict = verifyBytecodeExec(readFileSync(OUTFILE), MARKER);
if (!verdict.ok) {
    rmSync(OUTFILE, { force: true });
    fail(`the compiled executable failed the bytecode check: ${verdict.reason}`);
}
console.log(
    `[knext standalone-compile] ${keptOnDisk.size} module(s) shared with disk-loaded chunks kept on disk (disk closure: ${DISK_CLOSURE.size})`,
);
if (process.env.KNEXT_STANDALONE_COMPILE_VERBOSE === "1") {
    for (const f of [...keptOnDisk].sort()) console.log(`  kept on disk: ${relative(ROOT, f)}`);
}

// ── Computed specifiers in the bundle: the disk-closure scan's blind spot ────
// A computed require/import in BUNDLED code resolves from disk at runtime; if it
// loads a module the executable also bundled, that module has two instances.
// These cannot be closed statically, so the compile reports them. The reviewed
// set for Next's server core is pinned by standalone-computed-requires.test.ts.
const computedSites = computedRequireInventory(bundledFiles, ROOT);
const computedTotal = Object.values(computedSites).reduce((a, b) => a + b, 0);
console.log(
    `[knext standalone-compile] ${computedTotal} computed require/import site(s) in ${Object.keys(computedSites).length} bundled module(s) resolve at runtime, outside the disk-closure scan (KNEXT_STANDALONE_COMPILE_VERBOSE=1 lists them)`,
);
if (process.env.KNEXT_STANDALONE_COMPILE_VERBOSE === "1") {
    for (const [f, n] of Object.entries(computedSites)) console.log(`  computed: ${f} (${n})`);
}
console.log(
    `[knext standalone-compile] wrote ${OUTFILE} (bytecode: verified${TARGET ? `, target: ${TARGET}` : ""})`,
);
