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
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    existsSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBunBaseExe, sealBuild, sealCompile } from "./bun-base-exe.mjs";
import {
    HARFBUZZ_NOTICE_FILE,
    harfbuzzNoticeText,
    ogHarfbuzzWarning,
    resolvePinnedHarfbuzzWasm,
    vinextOgPackageJson,
} from "./og-harfbuzz.mjs";
import {
    assetAnchorPackageRoot,
    rewriteAssetAnchors,
    rewriteEntryHarfbuzzAnchors,
    rewriteImportMetaUses,
} from "./entry-asset-anchor.mjs";
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
import { verifyBytecodeExec, verifyBytecodeModules } from "./bytecode-exec-verify.mjs";
import {
    embedBuildOptions,
    parseIncludeJson,
    planEmbed,
    embeddedPathsMissing,
    planIncludes,
} from "./compile-embed.mjs";

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

const compileHere = dirname(fileURLToPath(import.meta.url));

// The ARP/neighbour-table primer (#1760, #1863), injected as the VERY FIRST
// import of the nitro entry — ahead of the keep-alive guard below (ESM
// evaluates a module's imports depth-first in source order, so the first
// import runs first; same mechanism the keep-alive guard's own comment relies
// on). On a flannel-VXLAN node (OKE) a stale neighbour entry for a recycled
// pod IP can black-hole a freshly-started pod for ~8.5s until it sends an
// outbound packet of its own — see arp-primer.cjs's header for the mechanism
// and the measurement. This stage has no supervisor in front of it the way
// `node-server.ts` does for the standalone targets (it requires the primer as
// its OWN first action instead — see its ENTRYPOINT comment), and
// `standalone-compile.mjs` bakes the same primer in first for the compiled
// standalone-on-Bun target — so this compiled vinext executable is the one
// remaining place it has to be wired in explicitly. Resolved beside THIS
// file, same extension in both dist and the source tree (tsup emits `.cjs`
// for format:cjs under `"type": "module"` — no dist/src split to try both
// extensions for, unlike the `.mjs`-sourced guards below).
const ARP_PRIMER_FILE = join(compileHere, "arp-primer.cjs");
if (!existsSync(ARP_PRIMER_FILE)) {
    // Fail CLOSED, matching every other preload below: a binary built
    // without it silently reintroduces the flannel cold-start stall this
    // fix exists to remove, with no signal until someone measures a cluster.
    console.error(
        "[knext compile] the ARP/neighbour-table primer is missing beside vinext-compile " +
            `(looked for arp-primer.cjs in ${compileHere}) — the installed @getknext/core is incomplete`,
    );
    process.exit(1);
}

// The Bun.serve keep-alive guard, injected as the nitro entry's SECOND import
// (right after the ARP primer above) so it patches `globalThis.Bun.serve`
// BEFORE srvx/bun calls it (ESM evaluates a module's imports depth-first in
// source order, so an earlier import runs first). This is how the mitigation
// reaches the COMPILED binary: a `bun --preload` cannot touch a compiled
// executable, so the guard has to be in the bundle. See
// bun-serve-keepalive-guard.mjs for the root cause (#silent-reset, the
// Bun.serve sibling of the node-lane #188 reset). Resolved beside THIS file:
// shipped as `.js` in dist, `.mjs` in the source tree (dev/tests) — try both.
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
 *  - `embed`: bare literals passed to a RECOGNISED require binding (local, or
 *    imported from the module that defines it) that resolve from the entry's
 *    own directory — either nitro's traced `.output/server/node_modules`
 *    sidecar (#1309/#1314: Node's upward node_modules walk from there reaches
 *    the sidecar directly) OR, when nitro bundled the package directly instead
 *    of leaving it external, the app's regular `node_modules` (cluster C11,
 *    `streaming-ssr`'s edge-runtime pages: a require reached only through the
 *    per-module-merge getter-indirection binding shape — see
 *    entry-require-staticize.mjs's header — for a package Bun's own static
 *    graph already bundled elsewhere, just not through THIS runtime call).
 *    Every require binding is wrapped to load these from the bundle.
 *  - `unresolved`: literals passed to a RECOGNISED require binding that do not
 *    resolve at all (not embeddable, from anywhere).
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
                if (embed.has(spec)) {
                    embed.get(spec).add(name(path));
                    continue;
                }
                // Resolvable from the entry's own directory covers BOTH cases
                // a confirmed require binding can reach: the sidecar (nitro
                // traced it to .output/server/node_modules, which Node's
                // upward node_modules walk from dirname(ENTRY) finds directly
                // — #1309/#1314) and, when nitro bundled the package directly
                // instead (cluster C11), the app's regular node_modules, found
                // the same way by walking further up. Either way this is a
                // real, embeddable file — AS LONG AS that walk stayed inside
                // the app's own workspace (`isWithinAppRoot`, round-2 review;
                // the boundary is the nearest ancestor `package.json` with a
                // `workspaces` field, or the app root itself when there is
                // none — see `findWorkspaceRoot`): the SAME upward walk has
                // no bound, so it can resolve a package that is not this
                // app's (or its workspace's) dependency at all, on the build
                // machine's own disk. A resolved-but-outside-root spec is
                // treated the SAME as an ordinary unresolvable one (warn by
                // default, fail only under KNEXT_COMPILE_STRICT_REQUIRES=1) —
                // never embedded silently, never a special hard failure
                // either: jev 0.99 picked consistency with the existing
                // unresolved-package handling over a bespoke always-fail path.
                let resolvable;
                try {
                    const resolved = Bun.resolveSync(spec, dirname(ENTRY));
                    resolvable = Boolean(resolved) && isWithinAppRoot(resolved);
                } catch {
                    resolvable = false;
                }
                const target = resolvable ? embed : ambiguous ? ambiguousUnresolved : unresolved;
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

/** Hard cap on an embedded asset-anchor sibling's size — a build error, never a silent skip. */
const ASSET_ANCHOR_MAX_BYTES = 16 * 1024 * 1024;

/**
 * A `new URL(<literal>, import.meta.url)` anchor that FEEDS A READ in the
 * package module at `modulePath` resolves to a real on-disk sibling, or it
 * does not (cluster C4 — see entry-asset-anchor.mjs's docstring for the full
 * mechanism: nitro already staged the sibling next to the module that reads
 * it, and a bundled module's `import.meta.url` under `--bytecode` is the
 * BUILD machine's path, not a portable one). `rewriteAssetAnchors` already
 * confines CALLS here to read anchors in a module inside some package
 * (`assetAnchorPackageRoot` is defined) — this function's own job is the
 * parts that need a real filesystem:
 *
 *   - existence: a literal that resolves to nothing is left untouched,
 *     never an error (absent-and-unused is fine, same as sharp);
 *   - CONTAINMENT: the candidate's REAL path (symlinks resolved) must stay
 *     inside the module's own package's REAL root. A `../../../etc/x`
 *     literal, or a symlink inside the package pointing outside it, is
 *     refused — a raw string-prefix check on the un-resolved path would miss
 *     the symlink case, which is why both sides are `realpathSync`'d before
 *     comparing;
 *   - SIZE: over `ASSET_ANCHOR_MAX_BYTES` fails the build with a named
 *     reason, never a silent cap-and-truncate.
 *
 * Containment and size violations THROW (Bun.build's own `onLoad` failure
 * path — the same convention `sharpAddonDlopen`/`selfContainedEmbed` use in
 * this file — so they surface through `result.success === false` and the
 * printed `result.logs`, not a bespoke `process.exit`).
 */
function resolveAssetAnchor(literal, modulePath) {
    const packageRoot = assetAnchorPackageRoot(modulePath);
    if (packageRoot === undefined) return undefined; // belt-and-suspenders; rewriteAssetAnchors already gates this
    const abs = resolve(dirname(modulePath), literal);
    if (!existsSync(abs)) return undefined;
    let realAbs;
    let realRoot;
    try {
        realAbs = realpathSync(abs);
        realRoot = realpathSync(packageRoot);
    } catch {
        return undefined;
    }
    if (realAbs !== realRoot && !realAbs.startsWith(`${realRoot}${sep}`)) {
        throw new Error(
            `[knext compile] asset anchor ${JSON.stringify(literal)} in ${modulePath} resolves to ` +
                `${realAbs}, outside its own package (${realRoot}) — refusing to embed a file that ` +
                "escapes the package it was found in (a '..' literal, or a symlink pointing outside it)",
        );
    }
    const size = statSync(realAbs).size;
    if (size > ASSET_ANCHOR_MAX_BYTES) {
        throw new Error(
            `[knext compile] asset anchor ${JSON.stringify(literal)} in ${modulePath} is ${size} bytes, ` +
                `over the ${ASSET_ANCHOR_MAX_BYTES}-byte asset-anchor cap (${realAbs}) — refusing to embed it`,
        );
    }
    return realAbs;
}

/**
 * Where an Emscripten `locateFile("<name>.wasm")` call in the `@vercel/og`
 * module at `modulePath` should read from inside the compiled executable
 * (#1872), or `undefined` to leave the call alone.
 *
 * 1. A real sibling of the module (an `@vercel/og` release that ships its
 *    `hb.wasm`) — same containment + size rules as `resolveAssetAnchor`.
 * 2. `hb.wasm` only: `@vercel/og` 1.x inlines harfbuzzjs's glue but 1.0.3 ships
 *    no `dist/hb.wasm` (vercel/satori#801). nitro externalizes `@vercel/og`, so
 *    vinext's own `vinext:og-harfbuzz` transform — which loads the binary from
 *    `harfbuzzjs` — never runs on the copy this compile bundles. The matching
 *    binary is the one in the exact-pinned chain the glue was built from:
 *    `@vercel/og` → `satori` → `harfbuzzjs/hb.wasm` (the same chain vinext
 *    resolves). nitro's staged copy carries no `satori`, so the chain is
 *    resolved from the module's own location, then the app's install, then
 *    vinext's (which depends on `@vercel/og`) — and ONLY accepted when every
 *    link matches the EXACT pin of the link before it: `satori` at the staged
 *    `@vercel/og`'s `dependencies.satori`, `harfbuzzjs` at that satori's
 *    `dependencies.harfbuzzjs`. A glue/binary mismatch is never embedded.
 */
function resolveEmscriptenWasm(name, modulePath) {
    const sibling = resolveAssetAnchor(`./${name}`, modulePath);
    if (sibling !== undefined || name !== "hb.wasm") return sibling;
    const packageRoot = assetAnchorPackageRoot(modulePath);
    if (packageRoot === undefined) return undefined;
    const ogPkg = join(packageRoot, "package.json");
    const startPoints = [ogPkg, join(APP_ROOT, "package.json")];
    const vinextOg = vinextOgPackageJson(APP_ROOT);
    if (vinextOg !== undefined) startPoints.push(vinextOg);
    return harfbuzzOrSignal(resolvePinnedHarfbuzzWasm(ogPkg, startPoints), modulePath);
}

const HARFBUZZ_WARNED = new Set();
/** hb.wasm paths handed to the bundle: the notice is written iff this is non-empty. */
const HARFBUZZ_EMBEDDED = new Set();

/**
 * A HarfBuzz resolution result -> the path to embed, or the build-time signal
 * when the loader IS in the bundle but no version-matched binary exists
 * (#1872): a loud warning by default — an app that never renders next/og is
 * unaffected, and vinext ships the og shim either way — and a FAILED build
 * under strict requires (`KNEXT_COMPILE_STRICT_REQUIRES=1` / self-contained),
 * the same split this compile already applies to unbundlable requires.
 */
function harfbuzzOrSignal(result, where) {
    if ("path" in result) {
        HARFBUZZ_EMBEDDED.add(result.path);
        return result.path;
    }
    const body = `${ogHarfbuzzWarning(result.reason)} (in ${where})`;
    if (STRICT_REQUIRES) throw new Error(`[knext compile] ${body}`);
    if (!HARFBUZZ_WARNED.has(body)) {
        HARFBUZZ_WARNED.add(body);
        console.warn(`[knext compile] ${body}`);
    }
    return undefined;
}

/** The asset-anchor pass's cost and yield, printed once after the build. */
const ASSET_ANCHOR_STATS = { modules: 0, analysed: 0, ms: 0, embedded: new Set() };

/**
 * The asset-anchor consumer analysis (asset-anchor-analyze.mjs), run as its
 * own `bun` process: it parses with acorn, a third-party package, and this
 * script's import closure must stay node-builtins-only (it holds the Bun
 * base-executable seal of bun-base-exe.mjs — see asset-anchor-analyze.mjs's
 * header). Resolved beside THIS file: `.js` in dist, `.mjs` in the source
 * tree. Fail CLOSED when absent:
 * without it every package's sibling-asset read (next/og's wasm and font
 * included) would silently ENOENT in the shipped binary.
 */
const ASSET_ANCHOR_ANALYZER = [
    join(compileHere, "asset-anchor-analyze.js"),
    join(compileHere, "asset-anchor-analyze.mjs"),
].find((c) => existsSync(c));
if (!ASSET_ANCHOR_ANALYZER) {
    console.error(
        "[knext compile] the asset-anchor analyzer is missing beside vinext-compile " +
            `(looked for asset-anchor-analyze.{js,mjs} in ${compileHere}) — the installed @getknext/core is incomplete`,
    );
    process.exit(1);
}

/** How long one analyzer process may take before the build gives up on it. */
const ASSET_ANCHOR_ANALYZER_TIMEOUT_MS = 120_000;

/**
 * `analyzeAssetAnchors(src)` for the module at `path`, in a child `bun`
 * process (source on stdin, JSON on stdout).
 *
 * A failure of the CHILD — it crashed, was killed (incl. the timeout), could
 * not load acorn, or printed something that is not an analysis — THROWS, which
 * fails the build (Bun.build's onLoad failure path). That is a broken knext
 * install, not a property of the app, and carrying on would silently drop
 * every embedded sibling (next/og's wasm and font included) and ship a binary
 * that ENOENTs. A module acorn cannot PARSE is different: the child reports it
 * as `parseError` and exits 0, and the caller warns and leaves that one module
 * as written.
 *
 * `--no-install`: with no `node_modules` above the analyzer, Bun would
 * otherwise auto-install a missing `acorn` from the registry at build time.
 */
function analyzeOutOfProcess(src, path) {
    ASSET_ANCHOR_STATS.analysed++;
    const analysis = runAnalyzer(src, path, []);
    const wellFormed =
        Array.isArray(analysis.anchors) &&
        analysis.anchors.every(
            (a) =>
                typeof a?.literal === "string" &&
                Number.isInteger(a.start) &&
                Number.isInteger(a.end) &&
                ["read", "excluded", "unknown"].includes(a.consumer),
        );
    if (!wellFormed) analyzerFailed(path, "printed JSON that is not an analysis");
    return analysis;
}

/** Throw the build-failing analyzer error (see `analyzeOutOfProcess`). */
function analyzerFailed(path, what) {
    throw new Error(
        `[knext compile] the asset-anchor analyzer (${ASSET_ANCHOR_ANALYZER}) ${what} while ` +
            `analysing ${path} — refusing to build a binary whose packages' sibling files ` +
            "(next/og's wasm and font among them) would not be embedded. This is a broken " +
            "@getknext/core install (is its `acorn` dependency present?); reinstall it.",
    );
}

/**
 * Run the analyzer child on `src` (with `flags`) and return its parsed JSON
 * object; any failure of the child itself throws via `analyzerFailed`.
 */
function runAnalyzer(src, path, flags) {
    const child = spawnSync(process.execPath, ["--no-install", ASSET_ANCHOR_ANALYZER, ...flags], {
        input: src,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: ASSET_ANCHOR_ANALYZER_TIMEOUT_MS,
    });
    const fail = (what) => analyzerFailed(path, what);
    if (child.error !== undefined || child.status !== 0) {
        const how =
            child.error?.code === "ETIMEDOUT"
                ? `timed out after ${ASSET_ANCHOR_ANALYZER_TIMEOUT_MS} ms`
                : child.status === null
                  ? `was killed by ${child.signal ?? child.error}`
                  : `exited ${child.status}`;
        const stderr = String(child.stderr ?? "").trim();
        fail(`${how}${stderr ? ` (${stderr.split("\n").slice(-3).join(" | ")})` : ""}`);
    }
    let analysis;
    try {
        analysis = JSON.parse(child.stdout);
    } catch {
        fail(`printed no JSON (${JSON.stringify(String(child.stdout).slice(0, 120))})`);
    }
    if (analysis === null || typeof analysis !== "object") {
        fail(`printed JSON that is not an analysis (${String(child.stdout).slice(0, 120)})`);
    }
    return analysis;
}

/**
 * The CODE-position `import.meta` uses of the compiled entry (acorn, out of
 * process — see `findImportMetaUses`), so the bytecode rewrite never splices
 * into a string that merely mentions `import.meta.url` (an MDX docs page's
 * code sample compiles to exactly that). A child failure throws like any
 * analyzer failure; an entry acorn cannot PARSE also fails the build (jev
 * 0.98 over falling back to the old textual replace, which corrupts such
 * strings) — Bun's own `--bytecode` step needs every use found, so a guess
 * either way ships a broken binary.
 */
function entryImportMetaUses(src, path) {
    const found = runAnalyzer(src, path, ["--import-meta"]);
    if (found.parseError !== undefined) {
        throw new Error(
            `[knext compile] could not parse the server entry ${path} to locate its import.meta ` +
                `uses (${found.parseError}) — refusing to rewrite it blind, since a textual rewrite ` +
                "corrupts any string that mentions import.meta",
        );
    }
    const wellFormed =
        Array.isArray(found.uses) &&
        found.uses.every(
            (u) =>
                Number.isInteger(u?.start) &&
                Number.isInteger(u.end) &&
                (u.prop === null || typeof u.prop === "string"),
        );
    if (!wellFormed) analyzerFailed(path, "printed JSON that is not an import.meta analysis");
    return found.uses;
}

/**
 * `rewriteAssetAnchors` for one non-entry module, timed and reported: every
 * embedded sibling is logged once, every anchor left unembedded for a reason a
 * user may care about (an unrecognised use, a missing file) gets one line, and
 * a module the parser cannot read is a named warning (left as written — never
 * guessed at). A failure of the analyzer PROCESS throws (see
 * `analyzeOutOfProcess`).
 */
function rewriteModuleAssetAnchors(raw, path) {
    const t0 = performance.now();
    const rewrite = rewriteAssetAnchors(
        raw,
        path,
        (literal) => resolveAssetAnchor(literal, path),
        (name) => resolveEmscriptenWasm(name, path),
        (src) => analyzeOutOfProcess(src, path),
    );
    ASSET_ANCHOR_STATS.ms += performance.now() - t0;
    ASSET_ANCHOR_STATS.modules++;
    if (rewrite.parseError !== undefined) {
        console.warn(
            `[knext compile] could not parse ${path} to analyse its asset anchors ` +
                `(${rewrite.parseError}) — left as written; NONE of its new URL(..., import.meta.url) ` +
                "sibling files were embedded, so a read of one fails once the binary leaves this machine",
        );
    }
    for (const skip of rewrite.skipped) {
        console.log(`[knext compile] did not embed ${skip.literal} for ${path}: ${skip.reason}`);
    }
    for (const asset of rewrite.assets) {
        if (ASSET_ANCHOR_STATS.embedded.has(asset.absPath)) continue;
        ASSET_ANCHOR_STATS.embedded.add(asset.absPath);
        console.log(`[knext compile] embedded sibling asset ${asset.absPath} (read by ${path})`);
    }
    return rewrite;
}

/** `import <id> from <path> with { type: "file" };` lines, one per embedded asset. */
function assetAnchorImports(assets) {
    return assets
        .map((a) => `import ${a.id} from ${JSON.stringify(a.absPath)} with { type: "file" };\n`)
        .join("");
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
                // Any other module reaching the compile — a chunk of the server
                // output, OR a server-external that stayed bundled because its
                // entry is ESM (`@vercel/og`, cluster C4 — see
                // entry-asset-anchor.mjs). The asset-anchor rewrite runs for
                // BOTH, but only touches a module inside some package, and
                // only an anchor that feeds a file read (`rewriteAssetAnchors`
                // gates on `path` and on each anchor's consumer) — the entry is
                // never inside a package, which is why this call is not
                // duplicated below for the entry branch. The require-binding
                // wrap stays confined to the server output proper (the only
                // place `PLAN.modules` has an analysis) — Bun rewrites a
                // bundled chunk's own `import.meta` itself; the guard imports
                // and the entry's import.meta rewrite below belong to the
                // entry alone.
                const raw = await Bun.file(path).text();
                const assetRewrite = rewriteModuleAssetAnchors(raw, path);
                let contents = assetRewrite.contents;
                let changed = assetRewrite.assets.length > 0;
                const analysis = PLAN.modules.get(path);
                if (analysis && isServerOutputModule(path)) {
                    const wrapped = wrapRequireBindings(contents, analysis.aliases, [...PLAN.embed.keys()]);
                    contents = wrapped.contents;
                    changed = changed || wrapped.count > 0;
                }
                if (!changed) return undefined;
                return {
                    contents: assetAnchorImports(assetRewrite.assets) + contents,
                    loader: "js",
                };
            }
            // The entry is never inside a package (it is nitro's own generated
            // `index.mjs`), so it never carries an asset anchor this rewrite
            // would touch — no call to rewriteAssetAnchors here, by
            // construction; see entry-asset-anchor.mjs's docstring on scope.
            // The ONE exception is HarfBuzz's binary, below (#1872).
            const rawEntry = await Bun.file(args.path).text();
            // #1872 (app router / middleware): the vinext-rewritten HarfBuzz
            // read nitro inlined here points at a file it never shipped —
            // embed the version-matched binary instead (see
            // rewriteEntryHarfbuzzAnchors). Only HarfBuzz's own anchor; nothing
            // else in the entry is touched. Runs BEFORE the import.meta rewrite.
            const hbRewrite = rewriteEntryHarfbuzzAnchors(rawEntry, () => {
                const vinextOg = vinextOgPackageJson(APP_ROOT);
                return harfbuzzOrSignal(
                    vinextOg === undefined
                        ? { reason: "vinext's @vercel/og is not resolvable from the app" }
                        : resolvePinnedHarfbuzzWasm(vinextOg, [vinextOg]),
                    ENTRY,
                );
            });
            if (hbRewrite.assets.length > 0) {
                console.log(
                    `[knext compile] embedded HarfBuzz hb.wasm for next/og (${hbRewrite.assets[0].absPath})`,
                );
            }
            const raw = assetAnchorImports(hbRewrite.assets) + hbRewrite.contents;
            // Prepend the preload imports FIRST, always — independent of whether
            // the entry uses import.meta. `import "<abs>";` is bundled + evaluated
            // before the rest of the entry's imports, firing the ARP primer and
            // patching Bun.serve in time.
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
            //
            // ARP_PRIMER_FILE is FIRST of all — before the keep-alive guard,
            // before the sidecar resolver, before the cache-control
            // normalization, before `import.meta` even exists as a concept in
            // this entry — because it is the earliest point anything in this
            // compiled process can send the one outbound packet #1760 needs.
            const src =
                `import ${JSON.stringify(ARP_PRIMER_FILE)};\n` +
                `import ${JSON.stringify(GUARD_FILE)};\n` +
                (SELF_CONTAINED ? "" : `import ${JSON.stringify(SIDECAR_INSTALL_FILE)};\n`) +
                `import ${JSON.stringify(CACHE_CONTROL_FILE)};\n` +
                (SELF_CONTAINED
                    ? `import __knextEmbeddedPublic from "${EMBEDDED_PREFIX}public";\n` +
                      "globalThis[Symbol.for(\"knext.embedded.public\")] = __knextEmbeddedPublic;\n"
                    : "") +
                wrapped.contents;
            console.log(
                "[knext compile] injected the ARP primer (#1760) and the Bun.serve keep-alive guard as the entry's first imports",
            );
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
            // CODE positions only (acorn, out of process): the text inside a
            // string, template text or comment is data and stays as written.
            const { contents: out, count, survived } = rewriteImportMetaUses(
                src,
                entryImportMetaUses(src, path),
                {
                    url: exprs.entryUrlExpr,
                    filename: exprs.entryFileExpr,
                    dirname: exprs.entryDirExpr,
                },
            );
            if (survived.length > 0) {
                // Bytecode would fail anyway; failing here says WHY, and names
                // the form that was not handled.
                throw new Error(
                    `[knext compile] ${survived.length} import.meta use(s) survived the rewrite ` +
                        `(e.g. ${survived[0]}); --bytecode cannot compile them`,
                );
            }
            console.log(
                `[knext compile] rewrote ${count} import.meta use(s) for bytecode`,
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
// Round-2 review (#1877): `planRuntimeRequires`'s embed computation resolves
// a confirmed require's spec via `Bun.resolveSync(spec, dirname(ENTRY))` —
// but Node's module resolution walks UPWARD through ancestor `node_modules`
// directories with NO bound, so that alone can succeed by finding a package
// that is not a dependency of this app at all (two directories above the app
// root on the BUILD MACHINE's own disk, say). Embedding that would make the
// binary's contents depend on the build machine's disk layout instead of the
// app's own declared dependencies.
//
// The boundary is the WORKSPACE root, not `APP_ROOT` itself (measured: this
// mattered on the real file-manager monorepo build). A workspace's own
// package manager hoists dependencies to a SHARED root `node_modules`, often
// reached from the app only through a symlink (bun: `apps/file-manager/
// node_modules/minio -> ../../../node_modules/.bun/minio@.../node_modules/
// minio`) — realpath-resolving that symlink (needed to be symlink-safe
// against a REAL escape) lands outside `APP_ROOT`, so confining the check to
// `APP_ROOT` alone rejected a real, declared, workspace-hoisted dependency as
// if it were a stranger on the build machine's disk. A hoisted workspace
// dependency is neither: every machine that `bun install`s the SAME
// workspace gets the SAME package at the SAME relative position, which is
// exactly the portability the ancestor-escape check exists to protect.
// `findWorkspaceRoot` walks up from `APP_ROOT` for the nearest ancestor
// `package.json` declaring a `workspaces` field, falling back to `APP_ROOT`
// itself (so a standalone, non-monorepo app keeps the tight original
// boundary). `isWithinAppRoot` is the containment check: realpath-compared
// (symlink-safe, same technique as sidecar-runtime.mjs's `isInside`), so a
// resolved path outside that boundary is still refused.
function findWorkspaceRoot(start) {
    let dir = start;
    for (;;) {
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
            try {
                if (JSON.parse(readFileSync(pkgPath, "utf8")).workspaces !== undefined) return dir;
            } catch {
                // Malformed package.json at this level — keep walking up.
            }
        }
        const parent = dirname(dir);
        if (parent === dir) return start; // filesystem root, no workspace found
        dir = parent;
    }
}
const CONTAINMENT_ROOT = findWorkspaceRoot(APP_ROOT);
let containmentRootRealCache;
function containmentRootReal() {
    if (containmentRootRealCache === undefined) {
        try {
            containmentRootRealCache = realpathSync(CONTAINMENT_ROOT);
        } catch {
            containmentRootRealCache = null;
        }
    }
    return containmentRootRealCache;
}
function isWithinAppRoot(resolvedPath) {
    const root = containmentRootReal();
    if (root === null) return false;
    try {
        const real = realpathSync(resolvedPath);
        return real === root || real.startsWith(`${root}${sep}`);
    } catch {
        return false;
    }
}
// knext.config.ts `compile.include` → `--include-json` (stock Bun): the matched
// JS/TS modules ride along as EXTRA entrypoints (compile-embed.mjs), embedded
// unexecuted at `$bunfs/root/<path relative to the app root>` and loaded on
// their first import. Absent → null → the compile options are unchanged.
let INCLUDE_PLAN = null;
// `--include-native 1`: the CLI resolved the opt-in knext-patched Bun toolchain
// (compile.bun: 'knext-patched'), which has `compile.include` — the SAME checked
// plan is embedded through it instead of as extra entrypoints. A Bun without the
// option ignores it silently; the embedded-path check below fails that build.
// @upstream-shim bun-patched-toolchain
const INCLUDE_NATIVE = args["include-native"] === "1";
try {
    const globs = parseIncludeJson(args["include-json"]);
    if (globs.length > 0) INCLUDE_PLAN = planIncludes(APP_ROOT, globs);
} catch (err) {
    console.error(`[knext compile] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}
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
    const shape = embedBuildOptions(INCLUDE_PLAN ?? planEmbed({ root: APP_ROOT, include: [] }), {
        entry: ENTRY,
        outfile: OUTFILE,
        includeSupported: INCLUDE_NATIVE && INCLUDE_PLAN !== null,
        cwd: process.cwd(),
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

/**
 * Disk mode with `compile.include`: the same options as below, plus the include
 * plan's modules as extra entrypoints under `root` = the app root.
 */
function includeBuildOptions(plan) {
    const shape = embedBuildOptions(plan, {
        entry: ENTRY,
        outfile: OUTFILE,
        includeSupported: INCLUDE_NATIVE,
        cwd: process.cwd(),
        bytecode: true,
        minify: true,
        extra: {
            plugins: [importMetaToCjs, sharpAddonDlopen, externalSidecar],
            // Same bytecode-proof banner as self-contained mode: extra entrypoints
            // change the build's shape, so the result is verified, not assumed.
            banner: `globalThis.__knextVinextExecMarker=${JSON.stringify(BYTECODE_MARKER)};`,
        },
    });
    return {
        ...shape,
        compile: sealCompile(shape.compile, TARGET ? { target: TARGET } : undefined),
    };
}

const result = await Bun.build(
    sealBuild(
        SELF_CONTAINED
            ? selfContainedBuildOptions()
            : INCLUDE_PLAN
              ? includeBuildOptions(INCLUDE_PLAN)
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
    ),
);

if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    process.exit(1);
}
console.log(
    `[knext compile] asset anchors: embedded ${ASSET_ANCHOR_STATS.embedded.size} sibling file(s); ` +
        `parsed ${ASSET_ANCHOR_STATS.analysed} of ${ASSET_ANCHOR_STATS.modules} module(s); ` +
        `${ASSET_ANCHOR_STATS.ms.toFixed(1)} ms`,
);
{
    // HarfBuzz (Old MIT) + harfbuzzjs (MIT) require their notice to ship with
    // the binary that embeds hb.wasm. The file is ALWAYS written beside the
    // binary — the image recipes COPY it by exact name (a lone no-match glob
    // fails the legacy docker builder) — and carries the licence text only
    // when hb.wasm was actually embedded.
    const noticePath = join(dirname(OUTFILE), HARFBUZZ_NOTICE_FILE);
    writeFileSync(
        noticePath,
        HARFBUZZ_EMBEDDED.size > 0
            ? harfbuzzNoticeText([...HARFBUZZ_EMBEDDED][0])
            : "Third-party notices for this knext executable\n\nNo third-party components that require a notice are embedded.\n",
    );
    console.log(`[knext compile] wrote the third-party notices (${noticePath})`);
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
if (INCLUDE_PLAN) {
    // Fail closed: every planned module must be IN the executable at its
    // `$bunfs/root` path. Catches a Bun that silently ignored `compile.include`
    // (native mode on a stock Bun) before the bytecode count would.
    const missing = embeddedPathsMissing(readFileSync(OUTFILE), INCLUDE_PLAN.relpaths);
    if (missing.length > 0) {
        rmSync(OUTFILE, { force: true });
        console.error(
            `[knext compile] compile.include: not embedded in the executable: ${missing.join(", ")}` +
                (INCLUDE_NATIVE ? " (this Bun did not honour compile.include)" : ""),
        );
        process.exit(1);
    }
}
if (INCLUDE_PLAN && !SELF_CONTAINED) {
    // Fail closed, as self-contained mode does: a binary without bytecode boots
    // and serves, just slower — the regression nobody notices.
    const verdict = verifyBytecodeModules(
        readFileSync(OUTFILE),
        BYTECODE_MARKER,
        1 + INCLUDE_PLAN.relpaths.length,
    );
    if (!verdict.ok) {
        rmSync(OUTFILE, { force: true });
        console.error(`[knext compile] the executable failed the bytecode check: ${verdict.reason}`);
        process.exit(1);
    }
}
if (INCLUDE_PLAN) {
    console.log(
        `[knext compile] compile.include: embedded ${INCLUDE_PLAN.relpaths.length} module(s): ` +
            INCLUDE_PLAN.relpaths.join(", "),
    );
    console.log(
        `[knext compile] compile.include: via ${INCLUDE_NATIVE ? "native --include (knext-patched Bun)" : "extra entrypoints (stock Bun)"}`,
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
