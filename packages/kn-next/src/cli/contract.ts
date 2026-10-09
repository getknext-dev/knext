/**
 * The 1.0 CLI contract: every verb, the flags it accepts, and the exit codes
 * it can return.
 *
 * This is the FROZEN, hand-authored commitment — the "1.0 promise" the docs
 * make. `__tests__/cli-contract.test.ts` cross-checks it against the ACTUAL
 * behaviour derived from each verb's own source (its parser function, its
 * `*_HELP`/`*_USAGE` text, or its `parseArgs` options object — never a second
 * hand-typed copy), so a change to a verb's real flags or exit codes without
 * updating this file reds that test. This mirrors the existing three-way
 * public-API-surface contract (`public-api-surface.test.ts`): one authoritative
 * source, cross-checked against reality, never duplicated by hand.
 *
 * `preview` and `loadtest` are included per the v1.0 audit even though they
 * are marked `@experimental` (see PUBLIC_API.md) and excluded from `--help` —
 * their CURRENT flags and codes are still worth freezing so a change to them
 * is visible, even though the semver promise around them is weaker.
 *
 * A verb whose exit code is produced by Node's natural process termination
 * rather than an explicit `process.exit(n)` call is noted as such in its
 * code's `mechanism` — currently only `db bind`/`db migrate`'s success path
 * (the dispatcher's one documented exception; see
 * `__tests__/deploy-entrypoint-dispatch.test.ts`, "#1279 ... the one exception
 * to the process.exit(await xMain(...)) shape"). Functionally equivalent to
 * an explicit `process.exit(0)` in every tested scenario; documented rather
 * than silently changed, since altering it would also require revising that
 * dispatcher test's carefully-engineered mocking.
 */

export interface VerbExitCode {
    readonly code: number;
    readonly meaning: string;
    /** Set only when the code is NOT produced by an explicit `process.exit(n)`. */
    readonly mechanism?: "natural-process-exit";
}

export interface VerbContract {
    readonly verb: string;
    /** Canonical flag tokens (both short and long forms listed separately). */
    readonly flags: readonly string[];
    readonly exitCodes: readonly VerbExitCode[];
    /** True for verbs excluded from `--help` (see `help.ts`'s INTERNAL_ONLY_VERBS). */
    readonly experimental?: true;
}

const OK: VerbExitCode = { code: 0, meaning: "success (including --help)" };
const USAGE_OR_FAILURE: VerbExitCode = {
    code: 1,
    meaning: "usage error, missing config, or the operation failed",
};

export const CLI_CONTRACT: readonly VerbContract[] = [
    {
        verb: "create",
        flags: [
            "--name",
            "--runtime",
            "--builder",
            "--cache",
            "--storage",
            "--react-compiler",
            "--no-react-compiler",
            "-y",
            "--yes",
            "--force",
            "--dry-run",
            "-h",
            "--help",
        ],
        exitCodes: [OK, USAGE_OR_FAILURE],
    },
    {
        verb: "init-ci",
        flags: [
            "--namespace",
            "--provider",
            "--app-dir",
            "--force",
            "--push-secret",
            "-h",
            "--help",
        ],
        exitCodes: [OK, USAGE_OR_FAILURE],
    },
    {
        verb: "ci-preflight",
        flags: ["--namespace", "--kubeconfig", "-h", "--help"],
        exitCodes: [
            OK,
            {
                code: 1,
                meaning:
                    "usage error, missing --namespace/kubeconfig, or the preflight failed",
            },
        ],
    },
    {
        verb: "vinext-patches",
        flags: ["--check", "-h", "--help"],
        exitCodes: [
            OK,
            {
                code: 1,
                meaning:
                    "usage error, a bundled vinext fix conflicts with the installed vinext, or --check found a fix not yet applied",
            },
        ],
    },
    {
        verb: "validate",
        flags: ["-h", "--help"],
        exitCodes: [
            OK,
            {
                code: 1,
                meaning:
                    "usage error, schema-invalid config, or a placeholder value remains",
            },
        ],
    },
    {
        verb: "doctor",
        flags: ["--json", "--verbose", "--ci-kubeconfig", "-h", "--help"],
        exitCodes: [
            OK,
            {
                code: 1,
                meaning: "a hard FAIL or a probe ERROR (never WARN/SKIP alone)",
            },
        ],
    },
    {
        verb: "deploy",
        flags: [
            "-r",
            "--registry",
            "-b",
            "--bucket",
            "-t",
            "--tag",
            "-n",
            "--namespace",
            "--context",
            "--image",
            "--skip-build",
            "--skip-upload",
            "--skip-image-lockstep-check",
            "--dry-run",
            "--private",
            "--public",
            "-h",
            "--help",
            "-v",
            "--version",
        ],
        exitCodes: [OK, USAGE_OR_FAILURE],
    },
    {
        verb: "build",
        flags: [
            "--skip-next",
            "--skip-smoke",
            "--self-contained",
            "--verbose",
            "-h",
            "--help",
        ],
        exitCodes: [OK, USAGE_OR_FAILURE],
    },
    {
        verb: "status",
        flags: [
            "-n",
            "--namespace",
            "--context",
            "--json",
            "--watch",
            "-h",
            "--help",
        ],
        exitCodes: [
            OK,
            {
                code: 1,
                meaning:
                    "Ready=False (present and False), a --watch timeout, or a fetch error",
            },
        ],
    },
    {
        verb: "rollback",
        flags: [
            "--to",
            "--canary",
            "-n",
            "--namespace",
            "--context",
            "-h",
            "--help",
        ],
        exitCodes: [OK, USAGE_OR_FAILURE],
    },
    {
        verb: "cleanup",
        flags: ["--context", "-h", "--help"],
        exitCodes: [OK, USAGE_OR_FAILURE],
    },
    {
        verb: "gc",
        flags: [
            "--build-id",
            "-n",
            "--namespace",
            "--context",
            "--dry-run",
            "-h",
            "--help",
        ],
        exitCodes: [
            {
                code: 0,
                meaning:
                    "always, once a run completes — including the no-storage announcement and every fail-safe SKIP (over-keep is never a failure)",
            },
            {
                code: 1,
                meaning: "usage error or the config could not be loaded",
            },
        ],
    },
    {
        verb: "db bind",
        flags: [
            "--secret",
            "--key",
            "--ro-secret",
            "--ro-key",
            "-n",
            "--namespace",
            "--context",
            "--dry-run",
            "--dsn",
            "--secret-file",
            "-h",
            "--help",
        ],
        exitCodes: [
            {
                ...OK,
                mechanism: "natural-process-exit",
            },
            USAGE_OR_FAILURE,
        ],
    },
    {
        verb: "db migrate",
        flags: ["--url", "--dir", "--migrations", "-h", "--help"],
        exitCodes: [
            {
                ...OK,
                mechanism: "natural-process-exit",
            },
            {
                code: 1,
                meaning:
                    "usage error, or the migration failed (fail-loud by design)",
            },
        ],
    },
    {
        verb: "preview",
        flags: ["--pr", "--branch", "-n", "--namespace", "--context"],
        exitCodes: [OK, USAGE_OR_FAILURE],
        experimental: true,
    },
    {
        verb: "loadtest",
        flags: [
            "-u",
            "--url",
            "-t",
            "--type",
            "-n",
            "--namespace",
            "--context",
        ],
        exitCodes: [
            OK,
            {
                code: 1,
                meaning:
                    "missing --url, an invalid --type, or the run failed to start",
            },
        ],
        experimental: true,
    },
];
