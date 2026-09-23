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
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBytecodeExec } from "./bytecode-exec-verify.mjs";
import {
    resolveExportsUnderNode,
    splitBareSpecifier,
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

// ── Plugins ──────────────────────────────────────────────────────────────────
const EMPTY = join(dirname(SERVER), ".knext-standalone-exec-empty.cjs");
writeFileSync(EMPTY, "module.exports = {};\n");

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
 *   3. a bare specifier Bun cannot resolve -> retried under Node's conditions.
 */
const standaloneResolver = {
    name: "knext-standalone-resolver",
    setup(build) {
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
                return isInside(realpathSync(resolved), ROOT)
                    ? undefined
                    : { path: a.path, external: true };
            }
            if (isBareSpecifier(a.path)) {
                const fallback = nodeConditionTarget(a.path, dirname(a.importer));
                if (fallback) return { path: fallback };
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
        bytecode: true,
        minify: true,
        // The bytecode-proof marker, as a BANNER so it sits directly under the
        // module's `// @bun …` pragma rather than after megabytes of bundled
        // Next source (where a stray "// @bun" string could sit in between).
        banner: `globalThis.__knextStandaloneExecMarker=${JSON.stringify(MARKER)};`,
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
    `[knext standalone-compile] wrote ${OUTFILE} (bytecode: verified${TARGET ? `, target: ${TARGET}` : ""})`,
);
