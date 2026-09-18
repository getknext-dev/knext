/**
 * The one seam for running the project's build script (UX ledger row 4, 4c).
 *
 * Both deploy and build invoke `npm run build` (which runs `next build`,
 * output:'standalone', or `vite build` for the vinext target). When the app's
 * dependencies are not installed yet, npm's shell cannot find `next`/`vite` and
 * exits 127 — and that used to render as FATAL + a serialized Error object,
 * because the #810 friendly-error contract covered USAGE mistakes only. For the
 * zero-cloud persona the answer is one sentence: run `npm install` first.
 *
 * This seam also owns the vinext ESM preflight. vinext builds with Vite/Rollup
 * (ESM); a CommonJS app dies deep inside vite/nitro with a cryptic
 * `[UNRESOLVED_IMPORT]` before this could ever help. The preflight fires HERE —
 * the real path — because both production callers of `buildVinextExecutable`
 * pass `skipViteBuild: true`; the app's actual `vite build` runs through this
 * seam, not there. It is target-gated: a `node`-target app's `npm run build`
 * is `next build`, which builds CommonJS fine and MUST NOT be blocked.
 *
 * A guard test (project-build.test.ts) scans src/cli for raw
 * `["npm", "run", "build"]` spawns so the translation cannot drift by one
 * caller re-inlining the command, and scans every `runProjectBuild(` call for
 * a `requireEsm` argument so the target gate cannot be silently skipped.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runQuiet } from "./exec";
import { UsageError } from "./shared";

/** Exit code every POSIX shell uses for "command not found". */
const EXIT_COMMAND_NOT_FOUND = 127;

const MISSING_NEXT_MESSAGE = `The build could not run: the \`next\` command was not found.

That usually means this app's dependencies are not installed yet.
Run \`npm install\` in this directory, then try again.`;

/**
 * Fail fast, before the build, when the app is not an ES module.
 *
 * vinext builds with Vite/Rollup (ESM). A CommonJS app dies deep inside
 * vite/nitro with a cryptic `[UNRESOLVED_IMPORT] Could not resolve
 * '../ssr/index.js'` — it cannot resolve the rsc↔ssr entry graph. Replace that
 * with a message that names the cause and the fix, thrown before the slow build
 * runs at all. Shared with `buildVinextExecutable` (one implementation).
 */
export function preflightEsmPackage(cwd: string): void {
    const pkgPath = join(cwd, "package.json");
    const unreadable = new UsageError(
        "The vinext single-executable build must run in an app directory containing a readable package.json.\n\n" +
            `Could not read or parse '${pkgPath}'.\n` +
            "Run this from the app's root, where its package.json lives.",
    );
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
        throw unreadable;
    }
    // `JSON.parse("null")` succeeds and yields null; reading `.type` off it
    // would throw an uncaught TypeError instead of our friendly message. Treat
    // any non-object (null included) as unreadable rather than crashing.
    if (typeof parsed !== "object" || parsed === null) {
        throw unreadable;
    }
    const pkg = parsed as { type?: unknown };

    if (pkg.type !== "module") {
        throw new UsageError(
            'The vinext single-executable target requires the app to be an ES module: its package.json must have `"type": "module"`.\n\n' +
                "vinext builds with Vite/Rollup (ESM); a CommonJS app fails to resolve the rsc↔ssr entry graph and dies mid-build.\n" +
                'Add `"type": "module"` to package.json (apps scaffolded with `kn-next create` already have it).',
        );
    }
}

export interface RunProjectBuildOptions {
    /**
     * Whether the resolved build target requires the app to be an ES module.
     * REQUIRED — not defaulted — so every caller is forced by the compiler to
     * decide. The vinext target (`config.build === "vinext"`, the default)
     * requires ESM; the node target does not.
     */
    readonly requireEsm: boolean;
    /** App directory to build/preflight in; defaults to the process cwd. */
    readonly cwd?: string;
    /**
     * Injectable for tests; the real runner inherits stderr, so the shell's own
     * `next: command not found` line appears right above the guidance.
     */
    readonly run?: (argv: readonly string[]) => void;
}

/**
 * Run `npm run build`, translating the deps-not-installed failure (exit 127)
 * into plain guidance. Raised through the UsageError FAMILY deliberately:
 * that is the CLI's friendly write-and-exit rendering path — an expected
 * local-environment state prints as a message and exit 1, never as
 * `log.fatal({ err })` with a stack and a dist chunk path. Any other build
 * failure is rethrown untouched — the underlying build's own stderr is already
 * on screen (stderr is inherited), and dressing a real build break up as
 * guidance would hide it.
 *
 * When `requireEsm` is true (vinext target) the ESM preflight runs FIRST, so a
 * CommonJS app fails fast with a named cause rather than deep inside vite.
 */
export function runProjectBuild(opts: RunProjectBuildOptions): void {
    const run = opts.run ?? runQuiet;
    const cwd = opts.cwd ?? process.cwd();

    if (opts.requireEsm) {
        preflightEsmPackage(cwd);
    }

    try {
        run(["npm", "run", "build"]);
    } catch (err) {
        if (
            typeof err === "object" &&
            err !== null &&
            (err as { status?: unknown }).status === EXIT_COMMAND_NOT_FOUND
        ) {
            throw new UsageError(MISSING_NEXT_MESSAGE);
        }
        throw err;
    }
}
