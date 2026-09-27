/**
 * Compile a vinext bundle into a single executable, WITH `--bytecode`, and with
 * a working `sharp`.
 *
 * Run under bun, by `kn-next build` and by knext's own reference app:
 *
 *   bun run vinext-compile.mjs --entry <.output/server/index.mjs> \
 *                              --outfile <path> [--target <bun triple>]
 *
 * ## Why this is a script and not `bun build --compile --bytecode`
 *
 * Two independent things break that command, and neither is reachable from a CLI
 * flag — `bun build` has no `--plugin`.
 *
 * ### 1. `--bytecode` cannot compile `import.meta`
 *
 * Bytecode emission targets CommonJS, where `import.meta` is a syntax error. A
 * nitro bundle uses `import.meta.url`, `.filename` and `.dirname`, so the build
 * fails with `Failed to generate bytecode for ./index.js`.
 *
 * They are rewritten to the executable's own path — the right anchor rather than
 * a convenient one, because once the server IS the binary, "this file" is the
 * binary. An earlier attempt used `__filename`, which is undefined in that
 * scope: the binary built and then died at boot inside `pathToFileURL(undefined)`.
 *
 * ### 2. `--compile` cannot resolve `sharp`, and no flag makes it
 *
 * Measured on bun 1.4.0, every resolution route fails inside the binary, and
 * none of them is a misconfiguration:
 *
 *   - sharp's own `require('@img/sharp-<platform>/sharp.node')` throws
 *     `Could not load the "sharp" module`;
 *   - `--external sharp` resolves from `/$bunfs/root/`, which has no
 *     `node_modules` above it;
 *   - `--asset=` embeds the `.node` and it is STILL unusable — the OS cannot
 *     `dlopen` a path inside the binary's virtual filesystem;
 *   - `createRequire(cwd)('sharp')` fails even with sharp and every dependency
 *     top-level in a flat `node_modules` beside the executable, while the
 *     identical call succeeds uncompiled.
 *
 * `process.dlopen` on an absolute real path does work. So sharp's JavaScript is
 * bundled here and only its addon stays a file on disk, shipped beside the
 * binary and opened by path.
 *
 * The interception happens at THIS step rather than in the app's `vite.config`,
 * because nitro externalizes sharp: `import sharp from "sharp"` survives into
 * `.output/server/index.mjs`, so sharp only enters a module graph now.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBunBaseExe, sealCompile } from "./bun-base-exe.mjs";
import {
    BUNDLED_PREFIX,
    hasNativeAddon,
    isCommonJsEntry,
    isSidecarCandidate,
    packageNameOf,
    sidecarShimSource,
} from "./entry-external-sidecar.mjs";
import {
    analyzeServerModule,
    wrapRequireBindings,
} from "./entry-require-staticize.mjs";
import { verifyBytecodeExec } from "./bytecode-exec-verify.mjs";
import { embedBuildOptions, planEmbed } from "./compile-embed.mjs";

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

const args = parseArgs(process.argv.slice(2));
const ENTRY = resolve(args.entry ?? ".output/server/index.mjs");
const OUTFILE = resolve(args.outfile ?? "knext-exec");
const TARGET = args.target?.trim();
// Opt-in (#1314): fail the build when a server module runtime-requires a
// package that cannot be bundled. The default only warns, because an optional
// dependency that is absent throws only if its code path actually runs.
// Opt-in (#1460, `kn-next build --self-contained`): the binary carries the nitro
// runtime, `.output/public` and sharp's native tree INSIDE itself and needs
// nothing beside it. Strict requires are FORCED on in this mode — a runtime
// require the analysis cannot bundle has nowhere on disk to fall back to, so it
// must fail the build rather than the first request that reaches it.
const SELF_CONTAINED = args["self-contained"] === "1";
const NATIVE_DIR = args["native-dir"] ? resolve(args["native-dir"]) : null;
const STRICT_REQUIRES =
    SELF_CONTAINED || process.env.KNEXT_COMPILE_STRICT_REQUIRES === "1";
// CI-only patched Bun base executable (infra/bun-base/): resolved and verified once, at import,
// inside bun-base-exe.mjs, and appended by sealCompile() to every compile value. Fail before any work.
try {
    assertBunBaseExe();
} catch (err) {
    console.error(`[knext compile] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}

if (!existsSync(ENTRY)) {
    console.error(
        `[knext compile] no vinext bundle at ${ENTRY} — run the app's build first`,
    );
    process.exit(1);
}

// The Bun.serve keep-alive guard, injected as the FIRST import of the nitro
// entry so it patches `globalThis.Bun.serve` BEFORE srvx/bun calls it (ESM
// evaluates a module's imports depth-first in source order, so the first import
// runs first). This is how the mitigation reaches the COMPILED binary: a
// `bun --preload` cannot touch a compiled executable, so the guard has to be in
// the bundle. See bun-serve-keepalive-guard.mjs for the root cause (#silent-reset,
// the Bun.serve sibling of the node-lane #188 reset). Resolved beside THIS file:
// shipped as `.js` in dist, `.mjs` in the source tree (dev/tests) — try both.
const compileHere = dirname(fileURLToPath(import.meta.url));
const GUARD_FILE = [
    join(compileHere, "bun-serve-keepalive-guard.js"),
    join(compileHere, "bun-serve-keepalive-guard.mjs"),
].find((c) => existsSync(c));
if (!GUARD_FILE) {
    // Fail CLOSED: the guard is load-bearing for the shipped artifact — a binary
    // built without it reintroduces the silent-reset cluster on linux-x64.
    console.error(
        "[knext compile] the Bun.serve keep-alive guard is missing beside vinext-compile " +
            `(looked for bun-serve-keepalive-guard.{js,mjs} in ${compileHere}) — refusing to ` +
            "compile a binary that would reintroduce the keep-alive socket-reset cluster",
    );
    process.exit(1);
}

// The sidecar resolver (#1320, sidecar-install.mjs), injected right after the
// guard so its Module._resolveFilename hook is in place before any bundled
// module initialises. Fail CLOSED: without it the entry shims silently use the
// bundled copies and runtime require.resolve calls cannot reach the sidecar.
const SIDECAR_INSTALL_FILE = [
    join(compileHere, "sidecar-install.js"),
    join(compileHere, "sidecar-install.mjs"),
].find((c) => existsSync(c));
if (!SIDECAR_INSTALL_FILE) {
    console.error(
        "[knext compile] the server-externals sidecar resolver is missing beside vinext-compile " +
            `(looked for sidecar-install.{js,mjs} in ${compileHere}) — the installed @getknext/core is incomplete`,
    );
    process.exit(1);
}

// The deployed-platform Cache-Control normalization on Bun.serve (#1322,
// bun-serve-cache-control.mjs): the same rule knext's Node runtime applies, so
// clients see `public, max-age=0, must-revalidate` rather than the origin's
// `s-maxage=…`. Injected after the sidecar resolver. Fail CLOSED: a binary
// without it silently diverges from every other knext runtime.
const CACHE_CONTROL_FILE = [
    join(compileHere, "bun-serve-cache-control-install.js"),
    join(compileHere, "bun-serve-cache-control-install.mjs"),
].find((c) => existsSync(c));
if (!CACHE_CONTROL_FILE) {
    console.error(
        "[knext compile] the Bun.serve Cache-Control normalization is missing beside vinext-compile " +
            `(looked for bun-serve-cache-control-install.{js,mjs} in ${compileHere}) — the installed @getknext/core is incomplete`,
    );
    process.exit(1);
}

/**
 * nitro's server output is its entry plus the chunks it splits off
 * (`chunks/*.mjs`); ANY of them can carry a module-scope
 * `createRequire(import.meta.url)` binding that reaches a package nitro left
 * external (#1314). Everything under the entry's directory except the traced
 * `node_modules` is that output.
 */
function isServerOutputModule(path) {
    const rel = relative(dirname(ENTRY), path);
    return (
        rel !== "" &&
        !rel.startsWith("..") &&
        !isAbsolute(rel) &&
        !rel.split(sep).includes("node_modules")
    );
}

/** A name a minifier would emit: at most 3 identifier characters. */
const MINIFIED_NAME = /^[A-Za-z_$][\w$]{0,2}$/;

/** At most `max` entries, then "+N more". */
function capList(items, max = 10) {
    return items.length <= max
        ? items.join(", ")
        : `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

/** `spec (module, module)` entries for a spec -> modules map. */
function specEntries(map) {
    return [...map.keys()]
        .sort()
        .map((spec) => `${spec} (${[...map.get(spec)].sort().join(", ")})`);
}
function describeSpecs(map) {
    return specEntries(map).join(", ");
}

/** Every server-output module (entry + chunks), by absolute path. */
function listServerOutputModules(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listServerOutputModules(path));
        else if (/\.m?js$/.test(entry.name)) out.push(resolve(path));
    }
    return out;
}

/**
 * The plan for nitro's runtime requires (#1309, #1314 — see
 * entry-require-staticize.mjs), computed over the WHOLE server output before
 * Bun.build runs, because rolldown puts the `createRequire(import.meta.url)`
 * binding in one module and the `__require("<pkg>")` calls in others.
 *
 *  - `embed`: bare literals passed to calls anywhere in the output whose
 *    package nitro traced into `.output/server/node_modules` and that resolve.
 *    Every require binding is wrapped to load these from the bundle.
 *  - `unresolved`: literals passed to a RECOGNISED require binding (local, or
 *    imported from the module that defines it) that are not embedded.
 *  - `dynamic`: modules calling a recognised require binding with a
 *    non-literal specifier (`__require(name)`): what it loads is known only at
 *    runtime, so it cannot be embedded.
 *  - `unrecognized`: modules with a `createRequire(import.meta.url)` shape the
 *    analysis could not see through.
 *  `unresolved`, `dynamic` and `unrecognized` warn, or fail the build under
 *  KNEXT_COMPILE_STRICT_REQUIRES=1.
 *
 *  The call analysis is scope-blind. In minified output the require binding is
 *  a one-letter name that bundled libraries also declare for their own
 *  functions and parameters (yaml's `u(e,r,a,s)` beside `u=e(import.meta.url)`),
 *  so a call through such a name is not proof of a require. A require name the
 *  module also DECLARES elsewhere is AMBIGUOUS: its hits go to
 *  `ambiguousUnresolved` / `ambiguousDynamic`, which warn but never fail the
 *  strict build. Only a MINIFIED-STYLE name (at most 3 characters) can be
 *  ambiguous: in unminified output rolldown keeps its own `__require` and
 *  renames top-level clashes (`__require$1`), so a long name that is declared
 *  again elsewhere (a parameter, an inner helper) does not make its real
 *  require hits doubtful — treating it as ambiguous would let a real failure
 *  through a strict build.
 */
function planRuntimeRequires() {
    const modules = new Map();
    for (const path of listServerOutputModules(dirname(ENTRY))) {
        modules.set(path, analyzeServerModule(readFileSync(path, "utf8")));
    }
    const name = (path) => relative(dirname(ENTRY), path);

    const embed = new Map();
    for (const [path, analysis] of modules) {
        for (const specs of analysis.literalCalls.values()) {
            for (const spec of specs) {
                if (!existsSync(join(SIDECAR_NODE_MODULES, packageNameOf(spec)))) continue;
                try {
                    Bun.resolveSync(spec, dirname(ENTRY));
                } catch {
                    continue;
                }
                const users = embed.get(spec) ?? new Set();
                users.add(name(path));
                embed.set(spec, users);
            }
        }
    }

    const unresolved = new Map();
    const ambiguousUnresolved = new Map();
    const dynamic = [];
    const ambiguousDynamic = [];
    const unrecognized = [];
    for (const [path, analysis] of modules) {
        if (analysis.unrecognizedBinding) unrecognized.push(name(path));
        // name -> declarations that would make a hit on it NOT a require:
        // beyond the binding's own declaration where it is defined, any at all
        // where it is imported.
        const requireNames = new Map();
        for (const binding of analysis.requireBindings) requireNames.set(binding, 1);
        for (const imp of analysis.imports) {
            const from = modules.get(resolve(dirname(path), imp.from));
            if (!from) continue;
            for (const binding of from.requireBindings) {
                for (const exported of from.exports.get(binding) ?? []) {
                    const local = imp.names.get(exported);
                    if (local) requireNames.set(local, 0);
                }
            }
        }
        for (const [callee, ownDeclarations] of requireNames) {
            const ambiguous =
                MINIFIED_NAME.test(callee) &&
                (analysis.declarationCounts.get(callee) ?? 0) > ownDeclarations;
            if (analysis.nonLiteralCallees.has(callee)) {
                (ambiguous ? ambiguousDynamic : dynamic).push(name(path));
            }
            for (const spec of analysis.literalCalls.get(callee) ?? []) {
                if (embed.has(spec)) continue;
                const target = ambiguous ? ambiguousUnresolved : unresolved;
                const users = target.get(spec) ?? new Set();
                users.add(name(path));
                target.set(spec, users);
            }
        }
    }
    return {
        modules,
        embed,
        unresolved,
        ambiguousUnresolved,
        dynamic: [...new Set(dynamic)].sort(),
        ambiguousDynamic: [...new Set(ambiguousDynamic)].sort(),
        unrecognized,
    };
}

/**
 * Self-contained (#1460): `import.meta.*` of the entry, reconstructed INSIDE the
 * binary. `.output/public` is embedded at its relative path under `$bunfs/root`,
 * so "this file" is the entry's own relative path under the embedded root, and
 * nitro's `../public` lands on the embedded tree. The compiled entry itself sits
 * at `$bunfs/root/<outfile name>` (Bun names it after the binary, not by the
 * naming template), so the root is `dirname(process.argv[1])` and the entry's
 * directory is re-added. Nothing reads the disk or the cwd.
 *
 * @param {string} entryRelDir the entry's directory relative to the app root, posix
 */
function selfContainedEntryExprs(entryRelDir) {
    const path = 'require("node:path")';
    const dir = `${path}.join(${path}.dirname(process.argv[1]),${JSON.stringify(entryRelDir)})`;
    const entryFileExpr = `(${path}.join(${dir},"index.mjs"))`;
    return {
        entryFileExpr,
        entryDirExpr: `(${dir})`,
        entryUrlExpr: `(require("node:url").pathToFileURL(${entryFileExpr}).href)`,
    };
}

/**
 * Injects the keep-alive guard import into the nitro entry AND rewrites
 * `import.meta.*` so `--bytecode`'s CommonJS output can hold it. Both act on the
 * SAME entry file, so they share one onLoad (Bun calls only the first plugin
 * whose onLoad returns contents for a given path).
 */
const importMetaToCjs = {
    name: "knext-entry-preamble-and-import-meta",
    setup(build) {
        build.onLoad({ filter: /\.m?js$/ }, async (args) => {
            const path = resolve(args.path);
            if (path !== ENTRY) {
                // A chunk of the server output: wrap its require bindings only.
                // Bun rewrites a bundled chunk's own `import.meta` itself; the
                // guard imports and the import.meta rewrite below belong to the
                // entry alone.
                const analysis = PLAN.modules.get(path);
                if (!analysis || !isServerOutputModule(path)) return undefined;
                const raw = await Bun.file(path).text();
                const wrapped = wrapRequireBindings(raw, analysis.aliases, [...PLAN.embed.keys()]);
                return wrapped.count > 0 ? { contents: wrapped.contents, loader: "js" } : undefined;
            }
            const raw = await Bun.file(args.path).text();
            // Prepend the guard imports FIRST, always — independent of whether the
            // entry uses import.meta. `import "<abs>";` is bundled + evaluated
            // before the rest of the entry's imports, patching Bun.serve in time.
            //
            // Then wrap the entry's `createRequire(import.meta.url)` bindings so
            // the EXTERNAL packages nitro reaches through them are bundled
            // (#1309, #1314 — see entry-require-staticize.mjs). This must run
            // BEFORE the import.meta rewrite below, which erases its anchor.
            const wrapped = wrapRequireBindings(
                raw,
                PLAN.modules.get(path)?.aliases ?? [],
                [...PLAN.embed.keys()],
            );
            // Self-contained: no sidecar resolver (there is no sidecar to
            // resolve from, and a `node_modules` planted beside the binary must
            // not be able to answer a require), and `.output/public` embedded
            // through a generated module of file imports.
            const src =
                `import ${JSON.stringify(GUARD_FILE)};\n` +
                (SELF_CONTAINED ? "" : `import ${JSON.stringify(SIDECAR_INSTALL_FILE)};\n`) +
                `import ${JSON.stringify(CACHE_CONTROL_FILE)};\n` +
                (SELF_CONTAINED
                    ? `import __knextEmbeddedPublic from "${EMBEDDED_PREFIX}public";\n` +
                      "globalThis[Symbol.for(\"knext.embedded.public\")] = __knextEmbeddedPublic;\n"
                    : "") +
                wrapped.contents;
            console.log(
                "[knext compile] injected the Bun.serve keep-alive guard as the entry's first import",
            );
            const before = (src.match(/import\.meta\.(url|filename|dirname)/g) ?? [])
                .length;
            if (before === 0) return { contents: src, loader: "js" };
            // These must reconstruct the ORIGINAL entry path
            // (<dirname(execPath)>/.output/server/index.mjs), NOT process.execPath
            // itself. nitro's bun preset resolves public assets as
            // `resolve(dirname(fileURLToPath(import.meta.url)), "../public")`;
            // pointing import.meta.url at the BINARY — which sits beside .output/,
            // not inside .output/server/ — makes "../public" climb one level too
            // high and every `_next/static/*` asset 500s with ENOENT on
            // `<parent>/public/…` (the "/tmp/public" bug, compat run 34441831428).
            // Reconstructing the real entry path makes "../public" resolve to
            // <root>/.output/public, where both the e2e build and the shipped
            // Dockerfiles (`COPY .output/public`) place it. Binary and `.output/`
            // are siblings by construction (e2e: ${APP_DIR}/knext-exec-e2e +
            // ${APP_DIR}/.output; Docker: /app/server + /app/.output). Sharp is
            // unaffected — it keys off process.execPath directly, not import.meta.
            const P = 'require("node:path")';
            const entryFileExpr = `(${P}.join(${P}.dirname(process.execPath),".output","server","index.mjs"))`;
            const entryDirExpr = `(${P}.join(${P}.dirname(process.execPath),".output","server"))`;
            const entryUrlExpr = `(require("node:url").pathToFileURL(${entryFileExpr}).href)`;
            const exprs = SELF_CONTAINED
                ? selfContainedEntryExprs(relative(APP_ROOT, ENTRY_DIR).split(sep).join("/"))
                : { entryFileExpr, entryDirExpr, entryUrlExpr };
            const out = src
                .replaceAll("import.meta.filename", exprs.entryFileExpr)
                .replaceAll("import.meta.dirname", exprs.entryDirExpr)
                .replaceAll("import.meta.url", exprs.entryUrlExpr);
            const after = (out.match(/import\.meta/g) ?? []).length;
            if (after > 0) {
                // Bytecode would fail anyway; failing here says WHY, and names
                // the form that was not handled.
                const sample = out.match(/import\.meta\.\w+/)?.[0] ?? "import.meta";
                throw new Error(
                    `[knext compile] ${after} import.meta use(s) survived the rewrite ` +
                        `(e.g. ${sample}); --bytecode cannot compile them`,
                );
            }
            console.log(
                `[knext compile] rewrote ${before} import.meta use(s) for bytecode`,
            );
            return { contents: out, loader: "js" };
        });
    },
};

/**
 * Replaces sharp's addon loader with the `process.dlopen` shim.
 *
 * Absent sharp is FINE and silent: an app that does not use `next/image` never
 * pulls sharp into the graph, and demanding it would break those builds. What is
 * not fine is sharp being present and the shim missing, which is why the shim
 * file's absence is an error rather than a skip.
 */
const sharpAddonDlopen = {
    name: "knext-sharp-addon-dlopen",
    setup(build) {
        // The VERBATIM shim, never the bundled one. `sharp-addon-dlopen.js`
        // (the tsup entry) is a legitimate module for the vite-alias path, but
        // tsup factors shared code into `chunk-*.js` files it imports — and
        // this plugin injects the shim's TEXT as sharp.mjs's contents, so any
        // relative import inside it resolves against SHARP's directory and
        // the compile dies with `Could not resolve "../chunk-…"`. That was
        // the sprint-close root cause: local runs used the chunkless source
        // and passed, CI ran the bundled dist and reddened four checks.
        const here = dirname(new URL(import.meta.url).pathname);
        const candidates = [
            // dist: the build-time verbatim copy (tsup onSuccess).
            join(here, "sharp-addon-dlopen.source.mjs"),
            // source tree: the original, for `bun run src/adapters/…` dev runs.
            join(here, "sharp-addon-dlopen.mjs"),
        ];
        const shimSrc = candidates.find((c) => existsSync(c));
        if (!shimSrc) {
            throw new Error(
                `[knext compile] sharp dlopen shim missing — looked for ${candidates.join(", ")}`,
            );
        }
        build.onLoad({ filter: /[\\/]sharp[\\/]dist[\\/]sharp\.(m|c)?js$/ }, async () => {
            const contents = await Bun.file(shimSrc).text();
            // Fail CLOSED on a non-self-contained shim: a relative import in
            // injected contents is exactly the poison described above, and
            // failing here names the cause instead of blaming sharp.mjs.
            const relativeImport = contents.match(/from\s+["']\.\.?\/|import\s+["']\.\.?\//);
            if (relativeImport) {
                throw new Error(
                    `[knext compile] the sharp dlopen shim at ${shimSrc} is not self-contained ` +
                        `(found ${JSON.stringify(relativeImport[0])}…) — its text is injected as ` +
                        "sharp.mjs's contents, so relative imports resolve against sharp's " +
                        "directory and cannot exist. Use the verbatim source copy, never a " +
                        "bundled build.",
                );
            }
            console.log("[knext compile] sharp addon loader -> dlopen shim");
            return { contents, loader: "js" };
        });
    },
};

/**
 * Server externals load from the traced sidecar beside the binary when it is
 * there, and from the bundle otherwise (#1320 — see entry-external-sidecar.mjs).
 *
 * Only the server OUTPUT's own bare imports (the entry and nitro's chunks, see
 * isServerOutputModule) are redirected: those are exactly the packages nitro
 * left external (it inlines everything else). A package's internal imports
 * resolve normally, so the bundled fallback is a normal bundle.
 */
const ENTRY_DIR = dirname(ENTRY);
const SIDECAR_NODE_MODULES = join(ENTRY_DIR, "node_modules");
const redirected = new Set();
const bundledEsm = new Set();
const externalSidecar = {
    name: "knext-external-sidecar",
    setup(build) {
        // The shim's bundled fallback: resolve the real specifier from the entry.
        build.onResolve({ filter: /^knext-bundled:/ }, (args) => ({
            path: Bun.resolveSync(args.path.slice(BUNDLED_PREFIX.length), ENTRY_DIR),
        }));
        build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (!args.importer || !isServerOutputModule(resolve(args.importer))) {
                return undefined;
            }
            if (!isSidecarCandidate(args.path)) return undefined;
            const pkg = join(SIDECAR_NODE_MODULES, packageNameOf(args.path), "package.json");
            if (!existsSync(pkg)) return undefined;
            // Only CommonJS entries: an ESM package's own imports bypass the
            // sidecar resolver at runtime, so it stays bundled.
            if (isCommonJsEntry(SIDECAR_NODE_MODULES, args.path) !== true) {
                bundledEsm.add(args.path);
                return undefined;
            }
            redirected.add(args.path);
            return { path: args.path, namespace: "knext-sidecar" };
        });
        build.onLoad({ filter: /.*/, namespace: "knext-sidecar" }, (args) => ({
            contents: sidecarShimSource(args.path),
            loader: "js",
        }));
    },
};

/**
 * Self-contained mode (#1460). Everything the nitro bun preset reads from disk
 * at runtime is embedded at the SAME relative path it has under the app root
 * (path fidelity), so `$bunfs/root/.output/public/…` is where nitro's asset
 * reader (`fsp.readFile(resolve(<entry dir>, "../public/…"))`) looks, and
 * `$bunfs/root/native/…` keeps the addon's relative rpath to libvips.
 *
 *  - `.output/public/**` and the staged `native/**` tree are embedded as FILE
 *    assets (`import x from "<abs>" with { type: "file" }`), byte-for-byte —
 *    client chunks must not be re-bundled.
 *  - `sharp` resolves to a lazy facade: sharp's whole module (its JavaScript
 *    calls into the addon at load) is evaluated on the FIRST image request,
 *    after sharp-native-extract.mjs unpacks the tree to a temp directory. Boot
 *    and `/api/health` never pay the unpack.
 */
const EMBEDDED_PREFIX = "knext-embedded:";
// Unique per build, so a stale binary cannot pass the bytecode proof.
const BYTECODE_MARKER = `knext-vinext-exec:${randomBytes(12).toString("hex")}`;
const APP_ROOT = dirname(dirname(ENTRY_DIR));
const PUBLIC_DIR = join(APP_ROOT, ".output", "public");
const EXTRACT_FILE = [
    join(compileHere, "sharp-native-extract.js"),
    join(compileHere, "sharp-native-extract.mjs"),
].find((c) => existsSync(c));

/** Every regular file under `dir`, as absolute paths, sorted. */
function listFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(path));
        else if (entry.isFile()) out.push(path);
    }
    return out.sort();
}

/** A generated module exporting `[{ rel, path }]` for `files`, each embedded as a file asset. */
function fileAssetModule(files, relTo) {
    const lines = files.map(
        (f, i) => `import f${i} from ${JSON.stringify(f)} with { type: "file" };`,
    );
    const rows = files.map(
        (f, i) => `{ rel: ${JSON.stringify(relative(relTo, f).split(sep).join("/"))}, path: f${i} }`,
    );
    return `${lines.join("\n")}\nexport default [${rows.join(", ")}];\n`;
}

let sharpFacaded = false;
const selfContainedEmbed = {
    name: "knext-self-contained-embed",
    setup(build) {
        build.onResolve({ filter: /^knext-embedded:/ }, (args) => ({
            path: args.path.slice(EMBEDDED_PREFIX.length),
            namespace: "knext-embedded",
        }));
        build.onLoad({ filter: /.*/, namespace: "knext-embedded" }, (args) => {
            if (args.path === "public") {
                const files = existsSync(PUBLIC_DIR) ? listFiles(PUBLIC_DIR) : [];
                console.log(
                    `[knext compile] self-contained: embedding ${files.length} file(s) of .output/public`,
                );
                return { contents: fileAssetModule(files, PUBLIC_DIR), loader: "js" };
            }
            if (args.path === "native") {
                const files = NATIVE_DIR && existsSync(NATIVE_DIR) ? listFiles(NATIVE_DIR) : [];
                if (files.length === 0) {
                    throw new Error(
                        "[knext compile] self-contained: the server output uses sharp, but no staged " +
                            `native tree was passed (--native-dir${NATIVE_DIR ? ` ${NATIVE_DIR} is empty` : " is missing"}) ` +
                            "— the binary would have no image backend. `kn-next build --self-contained` stages it first.",
                    );
                }
                console.log(
                    `[knext compile] self-contained: embedding sharp's native tree (${files.length} file(s)); ` +
                        "unpacked to TMPDIR on the first image request",
                );
                return { contents: fileAssetModule(files, NATIVE_DIR), loader: "js" };
            }
            throw new Error(`[knext compile] unknown embedded module ${args.path}`);
        });
        // The server output's `import sharp from "sharp"` → the lazy facade.
        build.onResolve({ filter: /^sharp$/ }, (args) => {
            if (!args.importer || !isServerOutputModule(resolve(args.importer))) return undefined;
            return { path: "sharp", namespace: "knext-sharp-lazy" };
        });
        build.onLoad({ filter: /.*/, namespace: "knext-sharp-lazy" }, () => {
            if (!EXTRACT_FILE) {
                throw new Error(
                    "[knext compile] the sharp native extractor is missing beside vinext-compile " +
                        `(looked for sharp-native-extract.{js,mjs} in ${compileHere}) — the installed @getknext/core is incomplete`,
                );
            }
            // sharp's ESM entry, explicitly: `require` would otherwise pick its
            // CommonJS build, whose `require('./sharp.cjs')` would receive the
            // ESM dlopen shim's namespace instead of the addon.
            const resolved = Bun.resolveSync("sharp", ENTRY_DIR);
            const esm = join(dirname(resolved), "index.mjs");
            const sharpEntry = existsSync(esm) ? esm : resolved;
            sharpFacaded = true;
            return {
                contents:
                    `import { extractEmbeddedNative, lazySharp, NATIVE_ROOT_KEY } from ${JSON.stringify(EXTRACT_FILE)};\n` +
                    `import files from "${EMBEDDED_PREFIX}native";\n` +
                    "export default lazySharp(() => {\n" +
                    '    if (!(process.env.KNEXT_SHARP_ADDON ?? "").trim()) {\n' +
                    "        globalThis[NATIVE_ROOT_KEY] = extractEmbeddedNative({ files }).root;\n" +
                    "    }\n" +
                    `    return require(${JSON.stringify(sharpEntry)}).default;\n` +
                    "});\n",
                loader: "js",
            };
        });
    },
};

/**
 * Self-contained: the set of things that must sit beside the binary has to be
 * EMPTY. Scanned, not enumerated: every package nitro traced into the server
 * output that ships a native addon is one the binary cannot load from inside
 * itself — except sharp's, which is embedded and unpacked on first use.
 */
function selfContainedSidecarViolations() {
    if (!existsSync(SIDECAR_NODE_MODULES)) return [];
    const names = [];
    for (const entry of readdirSync(SIDECAR_NODE_MODULES)) {
        if (entry.startsWith(".")) continue;
        if (entry.startsWith("@")) {
            for (const sub of readdirSync(join(SIDECAR_NODE_MODULES, entry))) names.push(`${entry}/${sub}`);
        } else names.push(entry);
    }
    return names
        .filter((name) => name !== "sharp" && !name.startsWith("@img/"))
        .filter((name) => hasNativeAddon(join(SIDECAR_NODE_MODULES, name)))
        .sort();
}

if (SELF_CONTAINED) {
    const violations = selfContainedSidecarViolations();
    if (violations.length > 0) {
        console.error(
            `[knext compile] self-contained: ${violations.join(", ")} ship(s) a native addon, which cannot ` +
                "load from inside the binary and has no sidecar to load from — self-contained mode embeds " +
                "only sharp's native tree. Build without --self-contained, or drop the dependency.",
        );
        process.exit(1);
    }
    if (NATIVE_DIR) {
        const rel = relative(APP_ROOT, NATIVE_DIR);
        if (rel.startsWith("..") || isAbsolute(rel)) {
            console.error(
                `[knext compile] self-contained: --native-dir ${NATIVE_DIR} must sit under the app root ${APP_ROOT}`,
            );
            process.exit(1);
        }
    }
}

const PLAN = planRuntimeRequires();
const DYNAMIC_MESSAGE =
    "a runtime require called with a non-literal package name (e.g. `__require(name)`) in " +
    `${PLAN.dynamic.join(", ")} — whatever it loads cannot be bundled`;
if (
    STRICT_REQUIRES &&
    (PLAN.unresolved.size > 0 || PLAN.dynamic.length > 0 || PLAN.unrecognized.length > 0)
) {
    if (PLAN.dynamic.length > 0) {
        console.error(`[knext compile] ${DYNAMIC_MESSAGE} (KNEXT_COMPILE_STRICT_REQUIRES=1)`);
    }
    if (PLAN.unresolved.size > 0) {
        console.error(
            "[knext compile] the server output runtime-requires package(s) that do not resolve " +
                `and cannot be bundled: ${describeSpecs(PLAN.unresolved)} (KNEXT_COMPILE_STRICT_REQUIRES=1)`,
        );
    }
    if (PLAN.unrecognized.length > 0) {
        console.error(
            "[knext compile] unrecognised createRequire(import.meta.url) binding in " +
                `${PLAN.unrecognized.join(", ")} — cannot verify its requires are bundled ` +
                "(KNEXT_COMPILE_STRICT_REQUIRES=1)",
        );
    }
    process.exit(1);
}

/**
 * Self-contained: F2's build shape (compile-embed.mjs) — `root` = the app root
 * and hash-free `[dir]/[name].[ext]` naming, so the entry and every embedded
 * asset keep their on-disk relative path under `$bunfs/root`. The runtime-require
 * plan adds no module FILES here: its `embed` set is packages, bundled through
 * the wrapped require bindings above.
 */
function selfContainedBuildOptions() {
    const shape = embedBuildOptions(planEmbed({ root: APP_ROOT, include: [] }), {
        entry: ENTRY,
        outfile: OUTFILE,
        includeSupported: false,
        bytecode: true,
        minify: true,
        extra: {
            plugins: [importMetaToCjs, sharpAddonDlopen, selfContainedEmbed],
            // The bytecode-proof marker, as a BANNER so it sits directly under
            // the module's `// @bun …` pragma (see bytecode-exec-verify.mjs).
            banner: `globalThis.__knextVinextExecMarker=${JSON.stringify(BYTECODE_MARKER)};`,
        },
    });
    return {
        ...shape,
        naming: { entry: shape.naming, chunk: shape.naming, asset: shape.naming },
        compile: sealCompile(shape.compile, TARGET ? { target: TARGET } : undefined),
    };
}

const result = await Bun.build(
    SELF_CONTAINED
        ? selfContainedBuildOptions()
        : {
              entrypoints: [ENTRY],
              target: "bun",
              plugins: [importMetaToCjs, sharpAddonDlopen, externalSidecar],
              minify: true,
              bytecode: true,
              // NEVER set `autoloadPackageJson` here: it widens runtime package
              // resolution beyond the sidecar. The sidecar is resolved by
              // sidecar-runtime.mjs instead, confined to <dir of the binary>/.output/
              // server/node_modules (#1320).
              compile: sealCompile({ outfile: OUTFILE }, TARGET ? { target: TARGET } : undefined),
          },
);

if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    process.exit(1);
}
if (SELF_CONTAINED) {
    // Fail closed: a self-contained binary without bytecode boots and serves,
    // just slower — the regression nobody notices.
    const verdict = verifyBytecodeExec(readFileSync(OUTFILE), BYTECODE_MARKER);
    if (!verdict.ok) {
        rmSync(OUTFILE, { force: true });
        console.error(`[knext compile] the self-contained executable failed the bytecode check: ${verdict.reason}`);
        process.exit(1);
    }
    console.log(
        "[knext compile] self-contained: nothing needs to sit beside the binary " +
            `(sharp: ${sharpFacaded ? "embedded, unpacked on first use" : "not used"}); bytecode verified`,
    );
}
if (PLAN.embed.size > 0) {
    console.log(
        `[knext compile] bundling ${PLAN.embed.size} package(s) the server output loads ` +
            `via createRequire(import.meta.url): ${describeSpecs(PLAN.embed)}`,
    );
}
if (PLAN.unresolved.size > 0) {
    console.warn(
        "[knext compile] WARNING: the server output runtime-requires package(s) that do not " +
            `resolve and cannot be bundled: ${describeSpecs(PLAN.unresolved)} — the binary ` +
            "throws if that code path runs (set KNEXT_COMPILE_STRICT_REQUIRES=1 to fail the build instead)",
    );
}
if (PLAN.ambiguousUnresolved.size > 0 || PLAN.ambiguousDynamic.length > 0) {
    const parts = [];
    if (PLAN.ambiguousUnresolved.size > 0) {
        parts.push(
            `package(s) that cannot be bundled: ${capList(specEntries(PLAN.ambiguousUnresolved))}`,
        );
    }
    if (PLAN.ambiguousDynamic.length > 0) {
        parts.push(`a non-literal package name in ${capList(PLAN.ambiguousDynamic)}`);
    }
    console.warn(
        "[knext compile] WARNING: possibly a runtime require of " +
            `${parts.join("; ")}. The require's name is also declared by other code in that ` +
            "module (common in minified output), so this may be a false alarm; it does not " +
            "fail a KNEXT_COMPILE_STRICT_REQUIRES=1 build",
    );
}
if (PLAN.dynamic.length > 0) {
    console.warn(
        `[knext compile] WARNING: ${DYNAMIC_MESSAGE}; the binary throws if it resolves a package ` +
            "that is not beside it (set KNEXT_COMPILE_STRICT_REQUIRES=1 to fail the build instead)",
    );
}
if (PLAN.unrecognized.length > 0) {
    console.warn(
        "[knext compile] WARNING: unrecognised createRequire(import.meta.url) binding in " +
            `${PLAN.unrecognized.join(", ")} — its runtime requires may not be bundled`,
    );
}
if (redirected.size > 0) {
    const specs = [...redirected].sort();
    console.log(
        `[knext compile] ${specs.length} server external(s) load from ${SIDECAR_NODE_MODULES} ` +
            `when it is beside the binary, else from the bundle: ${specs.join(", ")}`,
    );
    const natives = [...new Set(specs.map(packageNameOf))].filter((name) =>
        hasNativeAddon(join(SIDECAR_NODE_MODULES, name)),
    );
    if (natives.length > 0) {
        console.warn(
            `[knext compile] WARNING: ${natives.join(", ")} ship(s) a native addon, which cannot load ` +
                "from inside the binary. The binary loads it from .output/server/node_modules, so " +
                "that directory must be deployed next to the binary (built for the target platform).",
        );
    }
}
if (bundledEsm.size > 0) {
    console.log(
        `[knext compile] ${bundledEsm.size} ES-module server external(s) stay bundled (their own ` +
            `imports cannot reach the sidecar): ${[...bundledEsm].sort().join(", ")}`,
    );
}
console.log(
    `[knext compile] wrote ${OUTFILE} (bytecode: on${TARGET ? `, target: ${TARGET}` : ""})`,
);
