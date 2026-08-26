/**
 * ONE rule for "where is the root of this project" (#644).
 *
 * (No shebang: this is a library module, never an entry point. Every file under
 * `src/cli` that IS dispatched carries one — see `cli-node-runtime.test.ts`.)
 *
 * Three CLI paths need that answer and used to disagree:
 *
 *   - `create.ts` emits `.next/standalone/<prefix>server.js` paths, so it needs
 *     the directory Next.js traced from;
 *   - `deploy.ts` and `preview.ts` pass a directory to `docker buildx build` as
 *     the CONTEXT, so they need the directory that CONTAINS what Next traced.
 *
 * Those are the same directory, and the rule that finds it is Next's own:
 * `findRootDirAndLockFiles` walks up looking for a lockfile and traces from the
 * outermost one it finds. `deploy.ts` instead hardcoded
 * `resolve(process.cwd(), "../..")` — a claim that every app sits at
 * `apps/<name>`. That is true inside this monorepo and false for an app made by
 * `kn-next create` (#642) in a user's own repo, where the app IS the root and
 * the hardcode points two levels ABOVE the project.
 *
 * Choosing the lockfile walk is not a preference for the layout-independent
 * option; it is a correctness requirement. The build context has to agree with
 * what `output: "standalone"` actually produced, and Next decided that by this
 * rule. Any second rule is right only where it happens to coincide.
 *
 * Next's ACTUAL precedence, which this file follows: an explicit
 * `outputFileTracingRoot` / `turbopack.root` in the app's config wins, and the
 * lockfile walk is only the fallback (`next/dist/server/config.js`).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "../utils/logger";

/**
 * EXACTLY the lockfiles next 16.2's `findRootDirAndLockFiles` considers.
 *
 * `pnpm-workspace.yaml` is NOT in this list because it is not a lockfile — it is
 * handled FIRST, by `findWorkRoot` below, which is where Next handles it too.
 *
 * An earlier version of this comment said `pnpm-workspace.yaml` was deliberately
 * excluded because "Next does not consult it". That was false for the pinned
 * next 16.2.11 and cost users a working image (#857): `dist/lib/find-root.js`'s
 * `findWorkRoot` searches up for `pnpm-workspace.yaml` BEFORE any lockfile, and
 * its own comment gives the reason — lockfiles "can be included in the
 * application directory by accident".
 *
 * Each entry also names the package manager, because the generated Dockerfile
 * must install with the manager whose lockfile it found (`npm ci` cannot
 * consume a `pnpm-lock.yaml`).
 */
export const LOCKFILES: ReadonlyArray<{ file: string; install: string }> = [
    {
        file: "pnpm-lock.yaml",
        install: "corepack enable && pnpm install --frozen-lockfile",
    },
    { file: "package-lock.json", install: "npm ci" },
    {
        file: "yarn.lock",
        install: "corepack enable && yarn install --immutable",
    },
    // The node base image has no bun. Rather than emit a command the image
    // cannot run, install with npm from package.json and say so in the emitted
    // Dockerfile — switch the base image if you want bun's lockfile honoured.
    { file: "bun.lock", install: "npm install --no-audit --no-fund" },
    { file: "bun.lockb", install: "npm install --no-audit --no-fund" },
];

/** No lockfile anywhere: nothing to be frozen against. */
export const NO_LOCKFILE_INSTALL = "npm install --no-audit --no-fund";

/**
 * The workspace marker Next checks BEFORE any lockfile (#857).
 *
 * A pnpm workspace normally carries a `pnpm-lock.yaml` at the same root, and then
 * the frozen install is right. When it does not — a workspace that has never been
 * installed — `--frozen-lockfile` would fail on a lockfile that is not there, so
 * the unfrozen form is emitted instead. Either way the manager must be pnpm:
 * `npm ci` cannot consume a pnpm workspace.
 */
const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

export interface TracingRoot {
    /** The outermost lockfile-bearing ancestor of `appDir`, or null. */
    root: string | null;
    /** Install command matching the lockfile found at `root`. */
    installCmd: string;
    /**
     * EVERY lockfile found on the way up, innermost first — the same list, in
     * the same order, that Next's `findRootDirAndLockFiles` returns. It exists
     * so `>1` can be reported rather than silently resolved (see
     * `warnDuplicatedLockFiles` below).
     */
    lockFiles: string[];
}

/**
 * Next's tracing root for an app at `appDir`: the OUTERMOST lockfile-bearing
 * ancestor. With a lockfile in both the workspace root and (rarely) the app,
 * Next traces from the outer one, and guessing the inner one silently
 * mislocates every emitted path.
 *
 * `root` is null when no ancestor carries a lockfile. Callers decide what that
 * means for them — it is a normal state for `create` (the app is scaffolded
 * before anything is installed) and an unanswerable question for `deploy`.
 */
export function findTracingRoot(appDir: string): TracingRoot {
    let dir = resolve(appDir);
    let root: string | null = null;
    let installCmd = NO_LOCKFILE_INSTALL;
    const lockFiles: string[] = [];

    // A pnpm workspace ANYWHERE above the app roots the trace, and it outranks every
    // lockfile at every level — Next resolves the workspace file across the whole
    // ancestry before it looks at a single lockfile. So the walk asks that question
    // first, over the same ancestry, rather than per-directory: a `package-lock.json`
    // beside the app does NOT beat a `pnpm-workspace.yaml` three levels up, which is
    // precisely the case with the widest blast radius, because the workspace file is
    // invisible from the app directory (#857).
    for (let probe = dir; ; ) {
        if (existsSync(join(probe, PNPM_WORKSPACE_FILE))) {
            root = probe;
            installCmd = existsSync(join(probe, "pnpm-lock.yaml"))
                ? "corepack enable && pnpm install --frozen-lockfile"
                : "corepack enable && pnpm install";
            lockFiles.push(join(probe, PNPM_WORKSPACE_FILE));
        }
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    if (root !== null) return { root, installCmd, lockFiles };

    for (;;) {
        const hit = LOCKFILES.find((l) => existsSync(join(dir, l.file)));
        if (hit) {
            root = dir;
            installCmd = hit.install;
            lockFiles.push(join(dir, hit.file));
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return { root, installCmd, lockFiles };
}

/**
 * Next's config files, in the order Next itself resolves them
 * (`CONFIG_FILES` in `next/dist/shared/lib/constants.js`) — the FIRST that
 * exists wins, so the order is load-bearing, not decorative.
 */
const CONFIG_FILES = [
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "next.config.mts",
    "next.config.cjs",
    "next.config.cts",
];

/** Strip comments so a commented-out setting is not read as configuration. */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/**
 * The expression assigned to `key` in `source`, or null. Balanced enough for
 * the forms this file evaluates: it stops at the first `,` or `}` that is not
 * inside parentheses, brackets or a string.
 */
function assignedExpression(source: string, key: string): string | null {
    const at = source.search(new RegExp(`(^|[{,\\s])${key}\\s*:`, "m"));
    if (at < 0) return null;
    const start = source.indexOf(":", at) + 1;
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < source.length; i++) {
        const c = source[i];
        if (quote) {
            if (c === "\\") i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) {
            if (depth === 0) return source.slice(start, i).trim();
            depth--;
        } else if (c === "," && depth === 0)
            return source.slice(start, i).trim();
    }
    return source.slice(start).trim();
}

/** A single-quoted/double-quoted/backtick literal with no interpolation. */
function stringLiteral(expr: string): string | null {
    const m = expr.match(/^(["'`])((?:[^\\]|\\.)*?)\1$/s);
    if (!m) return null;
    if (m[1] === "`" && m[2].includes("${")) return null;
    return m[2].replace(/\\(.)/g, "$1");
}

/**
 * Evaluate the SMALL grammar Next's own documentation uses for these settings:
 * a string literal, or `path.join(__dirname, "…")` / `resolve(import.meta.dirname, "…")`
 * and friends. Returns null for anything else — deliberately, because guessing
 * at an arbitrary expression is how a context gets built from the wrong tree.
 */
function evaluateRootExpression(expr: string, appDir: string): string | null {
    const literal = stringLiteral(expr);
    if (literal !== null) return resolve(appDir, literal);

    const call = expr.match(
        /^(?:path\s*\.\s*)?(join|resolve)\s*\(([\s\S]*)\)$/,
    );
    if (!call) return null;
    const args = call[2].split(",").map((a) => a.trim());
    const [first, ...rest] = args;
    if (!/^(__dirname|import\s*\.\s*meta\s*\.\s*dirname)$/.test(first)) {
        return null;
    }
    const parts: string[] = [];
    for (const arg of rest) {
        const part = stringLiteral(arg);
        if (part === null) return null;
        parts.push(part);
    }
    // `__dirname` in a next.config IS the app directory.
    return resolve(appDir, ...parts);
}

/** An explicit tracing root from `next.config.*`, or null if none is set. */
export interface ConfiguredRoot {
    root: string;
    /** `<file>:<key>`, for messages that have to be actionable. */
    source: string;
}

/**
 * Read `outputFileTracingRoot` / `turbopack.root` out of the app's Next config.
 *
 * Next's precedence is EXPLICIT CONFIG FIRST, lockfile walk only as a fallback
 * (`next/dist/server/config.js`), and when both keys are set and disagree it
 * warns and uses `outputFileTracingRoot`. Honouring that is the difference
 * between "the context contains what Next traced" being an invariant and being
 * a coincidence — and it is also the escape hatch, so knext needs no flag of
 * its own.
 *
 * This READS the config; it does not execute it. An expression it cannot
 * evaluate THROWS rather than falling back to the walk: the user said "trace
 * from X", and quietly building from Y is precisely the divergence this whole
 * module exists to remove.
 */
export function configuredTracingRoot(appDir: string): ConfiguredRoot | null {
    const app = resolve(appDir);
    const file = CONFIG_FILES.find((f) => existsSync(join(app, f)));
    if (!file) return null;
    const source = stripComments(readFileSync(join(app, file), "utf8"));

    const turbopack = assignedExpression(source, "turbopack");
    const candidates: { key: string; expr: string }[] = [];
    const tracing = assignedExpression(source, "outputFileTracingRoot");
    if (tracing)
        candidates.push({ key: "outputFileTracingRoot", expr: tracing });
    if (turbopack) {
        const tpRoot = assignedExpression(turbopack, "root");
        if (tpRoot) candidates.push({ key: "turbopack.root", expr: tpRoot });
    }
    // Next's rule when both are set: `outputFileTracingRoot || turbopack.root`.
    const chosen = candidates[0];
    if (!chosen) return null;

    const root = evaluateRootExpression(chosen.expr, app);
    if (root === null) {
        throw new Error(
            `Cannot determine the Docker build context: ${file} sets ` +
                `\`${chosen.key}\` to an expression knext cannot evaluate ` +
                `without running your config (${chosen.expr}).\n` +
                "The build context must be the directory Next.js traces from, and " +
                "guessing it would ship an image built from the wrong tree.\n" +
                `Set \`${chosen.key}\` to a string literal or ` +
                "`path.join(__dirname, …)`, or remove it to fall back to the " +
                "lockfile-inferred root.",
        );
    }
    return { root, source: `${file}:${chosen.key}` };
}

/**
 * Warn — Next's `warnDuplicatedLockFiles`, which knext had copied the inference
 * from without copying the mitigation.
 *
 * It matters more here than it does in Next: knext hands the inferred directory
 * to `docker buildx build`, and the scaffolded Dockerfile does `COPY . .`. A
 * stray `~/package-lock.json` therefore does not merely mis-trace a build, it
 * bakes `~/.ssh` and `~/.aws` into a PUSHED image.
 */
function warnDuplicatedLockFiles(
    lockFiles: string[],
    root: string,
    warn: (message: string) => void,
): void {
    if (lockFiles.length <= 1) return;
    const extras = lockFiles
        .slice(0, -1)
        .map((f) => `\n   * ${f}`)
        .join("");
    warn(
        "Multiple lockfiles detected — knext inferred your project root, but it " +
            `may not be correct. Using ${root} as the Docker build context, from ` +
            `${lockFiles[lockFiles.length - 1]}.\n` +
            "Everything under that directory is sent to `docker build` and, with " +
            "the default Dockerfile's `COPY . .`, can end up INSIDE the pushed " +
            "image. Check that is what you intend.\n" +
            "To pin it, set `outputFileTracingRoot` in next.config, or remove the " +
            `lockfile you do not need. Also detected:${extras}`,
    );
}

/** Default warning sink: the CLI logger. */
const log = createLogger({ module: "tracing-root" });

/**
 * The docker build context for an app at `appDir`, or THROW.
 *
 * Order of resolution mirrors Next's exactly: an explicit `outputFileTracingRoot`
 * / `turbopack.root` first, then the lockfile walk.
 *
 * Deploy has no safe default when neither answers. Without a lockfile the two
 * plausible guesses — "the app directory" and "some ancestor" — differ, and
 * picking one silently builds an image from a context that may exclude files
 * the traced server imports, or include the user's entire home directory. So it
 * fails, and the message says which directory was searched and what to do.
 */
export function requireBuildContext(
    appDir: string,
    warn: (message: string) => void = (m) => log.warn(m),
): string {
    const configured = configuredTracingRoot(appDir);
    if (configured) return configured.root;

    const { root, lockFiles } = findTracingRoot(appDir);
    if (root) warnDuplicatedLockFiles(lockFiles, root, warn);
    if (!root) {
        throw new Error(
            `Cannot determine the Docker build context: no lockfile found in ${resolve(appDir)} ` +
                "or any parent directory.\n" +
                `Next.js infers its file-tracing root the same way (${LOCKFILES.map((l) => l.file).join(", ")}), ` +
                "so without one the build context and the standalone output cannot be made to agree.\n" +
                "Run your package manager's install in the project root to create a lockfile, and commit it.",
        );
    }
    return root;
}
