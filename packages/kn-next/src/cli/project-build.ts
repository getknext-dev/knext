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
import { createRequire } from "node:module";
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
     * decide. The vinext target (`config.build === "vinext"`, selectable
     * since #1183 — no longer the default) requires ESM; the standalone
     * (turbopack/webpack) target does not.
     */
    readonly requireEsm: boolean;
    /** App directory to build/preflight in; defaults to the process cwd. */
    readonly cwd?: string;
    /**
     * Injectable for tests; the real runner inherits stderr, so the shell's own
     * `next: command not found` line appears right above the guidance.
     */
    readonly run?: (argv: readonly string[]) => void;
    /**
     * The resolved builder id (`config.build ?? DEFAULT_BUILDER_ID`) — gates
     * {@link checkTurbopackAdapterStandaloneRegression}. Optional (not
     * REQUIRED like `requireEsm`) because some callers, e.g. the vinext single-
     * executable path, do not resolve a `BuilderAdapter` at all; `undefined`
     * skips the check rather than guessing.
     */
    readonly builderId?: string;
}

/**
 * The exact 16.3.0 canary at which the regression was introduced (confirmed
 * by bisection, #1372) — 16.3.0 canaries below this are unaffected.
 */
const AFFECTED_16_3_0_CANARY_FLOOR = 20;

/**
 * The 16.3.x PATCH that carries the upstream fix (confirmed release, #1372
 * close-out) — 16.3.0 through 16.3.4 (stable or any canary/prerelease of
 * those) are affected; 16.3.5+ is fixed. Does NOT apply uniformly to patch 1
 * — see {@link FIXED_16_3_1_CANARY}.
 */
const FIXED_16_3_PATCH = 5;

/**
 * The earliest 16.3.1 CANARY confirmed to carry the upstream fix (commit
 * c7b87c23, #97287, merged 2026-08-14): rev-1386's review measured that
 * commit as an ancestor of `16.3.1-canary.17` but NOT of `16.3.1-canary.16`
 * — so, UNLIKE every other patch in the affected range, 16.3.1's OWN canary
 * line straddles the fix mid-patch rather than being wholly affected or
 * wholly fixed by its patch number alone. `16.3.1-canary.16` and below (and
 * the `16.3.1` STABLE release, which shipped before any of its canaries
 * reached this floor) are affected; `16.3.1-canary.17` and above are fixed,
 * even though `1 < FIXED_16_3_PATCH` would otherwise say "affected".
 */
const FIXED_16_3_1_CANARY = 17;

/** A parsed `major.minor.patch[-canary.N]` Next.js version. */
interface ParsedNextVersion {
    major: number;
    minor: number;
    patch: number;
    /** `undefined` for a stable release (no prerelease tag). */
    canary: number | undefined;
}

function parseNextVersion(version: string): ParsedNextVersion | undefined {
    const m = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-canary\.(\d+))?/);
    if (!m) return undefined;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        canary: m[4] !== undefined ? Number(m[4]) : undefined,
    };
}

/**
 * Whether a parsed Next.js version falls inside the CONFIRMED #1372 window:
 * `16.3.0-canary.20` through `16.3.4` inclusive on the 16.3.x line (16.2.x
 * was never affected — the credentialed compat lane's 16.2.0 pin proves it
 * builds this exact combination fine), fixed from `16.3.5` onward, with ONE
 * documented exception inside that range (16.3.1's own canary straddle, see
 * {@link FIXED_16_3_1_CANARY}). The 16.4.0 line needs no floor at all: its
 * very first published canary (`16.4.0-canary.0`, cut 2026-08-21) already
 * postdates the upstream fix commit (merged 2026-08-14), so every 16.4.x
 * version this function can see falls through to the final `return false` —
 * there is no boundary to encode, unlike 16.3.0's. A version this function
 * cannot place in the 16.x line (any other major) is also unaffected — this
 * is a CLOSED, bisected range now, not an open-ended "anything new might be
 * broken" guess.
 */
function isAffectedNextVersion(v: ParsedNextVersion): boolean {
    if (v.major !== 16) return false;
    if (v.minor < 3) return false;
    if (v.minor === 3) {
        if (v.patch === 0) {
            // A 16.3.0 canary is affected only from the confirmed floor
            // onward; the 16.3.0 STABLE release (no canary suffix) shipped
            // AFTER that floor and before the fix, so it is affected too.
            return (
                v.canary === undefined ||
                v.canary >= AFFECTED_16_3_0_CANARY_FLOOR
            );
        }
        if (v.patch === 1) {
            // The one patch whose OWN canary line straddles the fix commit
            // (see FIXED_16_3_1_CANARY's doc comment) — `v.patch <
            // FIXED_16_3_PATCH` alone is not enough here, unlike patches 2-4.
            return v.canary === undefined || v.canary < FIXED_16_3_1_CANARY;
        }
        return v.patch < FIXED_16_3_PATCH;
    }
    return false;
}

/**
 * #1372 pre-build guard: a confirmed, now-BISECTED-AND-FIXED Next.js
 * regression — `.next/next-server.js.nft.json` was never written when
 * `adapterPath` + `output:'standalone'` were built under Turbopack, from
 * `16.3.0-canary.20` through `16.3.4` (16.2.x was never affected; fixed
 * upstream at `16.3.5`, and on the 16.4 canary line from its first canary —
 * see {@link isAffectedNextVersion}). Every app on the `turbopack` builder
 * wires `adapterPath` by construction (it is what that target IS), so this
 * is not scaffold-specific: ANY `kn-next build` on the default target with
 * an affected Next version hits it, including apps this CLI did not
 * scaffold. Fail BEFORE the (guaranteed-to-fail) build runs, with the actual
 * fix named, rather than let the raw Next stack trace ("ENOENT
 * .next/next-server.js.nft.json") stand as the only signal.
 *
 * Two escape hatches, both checked so this never blocks an app that already
 * worked around the bug: (1) `builderId !== "turbopack"` — the `webpack`
 * builder is unaffected by construction (same `next build`, different
 * bundler flag), and the `vinext` target never calls adapter hooks at all;
 * (2) the app's OWN package.json `build` script already passing
 * `--webpack`. `--turbopack` is deliberately NOT an escape hatch — it is the
 * exact broken configuration this guard exists to catch (explicitly
 * requesting Turbopack does not un-break it), so a script that names
 * `--turbopack` still hits the check and gets the guard message instead of
 * a raw ENOENT.
 *
 * The Next version read resolves through Node's own module resolution
 * (`createRequire` rooted at the app's package.json), not a hardcoded
 * `<cwd>/node_modules/next` path — in an npm/bun workspace, Next is commonly
 * HOISTED to a workspace root several directories above `cwd`, and a naive
 * `join(cwd, "node_modules", "next", ...)` read silently misses it there,
 * skipping the guard exactly where a monorepo scaffold is most likely to hit
 * the regression. Best-effort either way: an unresolvable `next` (offline
 * install, unusual layout, or a `next` too old to carry `adapterPath` at
 * all) is not itself a guard failure — skip silently rather than block a
 * build this check cannot evaluate.
 */
export function checkTurbopackAdapterStandaloneRegression(
    cwd: string,
    builderId: string,
): void {
    if (builderId !== "turbopack") return;

    let buildScript: unknown;
    try {
        const appPkg = JSON.parse(
            readFileSync(join(cwd, "package.json"), "utf8"),
        ) as { scripts?: Record<string, unknown> };
        buildScript = appPkg.scripts?.build;
    } catch {
        return;
    }
    if (typeof buildScript === "string" && /--webpack\b/.test(buildScript)) {
        // Already opted out of the ambient Turbopack default — nothing to
        // warn about. `--turbopack` is NOT checked for here: it is the
        // broken configuration, not an opt-out of it.
        return;
    }

    let nextVersion: string;
    try {
        const nextPkgPath = createRequire(join(cwd, "package.json")).resolve(
            "next/package.json",
        );
        const nextPkg = JSON.parse(readFileSync(nextPkgPath, "utf8")) as {
            version?: unknown;
        };
        if (typeof nextPkg.version !== "string") return;
        nextVersion = nextPkg.version;
    } catch {
        return;
    }
    const parsed = parseNextVersion(nextVersion);
    if (!parsed || !isAffectedNextVersion(parsed)) return;

    throw new UsageError(
        `next@${nextVersion} does not build on the turbopack target: it never writes ` +
            "`.next/next-server.js.nft.json` when the official Next.js Deployment Adapter " +
            "(`adapterPath`) is combined with `output:'standalone'` under Turbopack — a " +
            "confirmed Next.js regression (16.3.0-canary.20 through 16.3.4), fixed upstream " +
            "in 16.3.5, not a knext defect. " +
            "See https://github.com/getknext-dev/knext/issues/1372 for the full trace.\n\n" +
            "Fix: upgrade to next ≥ 16.3.5, or add `--webpack` to this app's package.json " +
            '`build` script (`"build": "next build --webpack"`) as a workaround — node/bun x ' +
            "webpack is an already-verified knext build target.",
    );
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

    if (opts.builderId !== undefined) {
        checkTurbopackAdapterStandaloneRegression(cwd, opts.builderId);
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
