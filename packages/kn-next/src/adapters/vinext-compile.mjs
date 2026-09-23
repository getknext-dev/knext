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
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// The `@opentelemetry/api` require shim (#1309) — see otel-api-compile-shim.mjs
// for the full root cause. vinext 1.0.0-beta.11's built-in tracing resolves
// `@opentelemetry/api` via `globalThis.require`, which `Bun.build` cannot see
// statically, so the compiled binary throws `Cannot find module
// '@opentelemetry/api'` on every request unless this shim installs first.
// Optional, unlike the keep-alive guard: an app whose vinext dist never
// reaches that code path just gets an unused shim, so absence is a WARNING,
// not a fail-closed abort.
const OTEL_SHIM_FILE = [
    join(compileHere, "otel-api-compile-shim.js"),
    join(compileHere, "otel-api-compile-shim.mjs"),
].find((c) => existsSync(c));
if (!OTEL_SHIM_FILE) {
    console.error(
        "[knext compile] WARNING: otel-api-compile-shim.{js,mjs} not found beside vinext-compile " +
            `(looked in ${compileHere}) — if the vinext dist's built-in tracing reaches a ` +
            "globalThis.require('@opentelemetry/api') call, the compiled binary will 500 on every request",
    );
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
            if (resolve(args.path) !== ENTRY) return undefined;
            const raw = await Bun.file(args.path).text();
            // Prepend the guard imports FIRST, always — independent of whether the
            // entry uses import.meta. `import "<abs>";` is bundled + evaluated
            // before the rest of the entry's imports, patching Bun.serve (and
            // installing the otel require shim) in time.
            const preamble = [
                `import ${JSON.stringify(GUARD_FILE)};`,
                OTEL_SHIM_FILE ? `import ${JSON.stringify(OTEL_SHIM_FILE)};` : "",
            ]
                .filter(Boolean)
                .join("\n");
            const src = `${preamble}\n${raw}`;
            console.log(
                "[knext compile] injected the Bun.serve keep-alive guard" +
                    (OTEL_SHIM_FILE ? " and the @opentelemetry/api require shim" : "") +
                    " as the entry's first import(s)",
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
            const out = src
                .replaceAll("import.meta.filename", entryFileExpr)
                .replaceAll("import.meta.dirname", entryDirExpr)
                .replaceAll("import.meta.url", entryUrlExpr);
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

const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "bun",
    plugins: [importMetaToCjs, sharpAddonDlopen],
    minify: true,
    bytecode: true,
    compile: {
        outfile: OUTFILE,
        ...(TARGET ? { target: TARGET } : {}),
    },
});

if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    process.exit(1);
}
console.log(
    `[knext compile] wrote ${OUTFILE} (bytecode: on${TARGET ? `, target: ${TARGET}` : ""})`,
);
