/**
 * The `kn-next --help` text — the CLI's front door.
 *
 * It lives in its own module (rather than inline in the bin) so the surface can
 * be asserted directly by cli-help-surface.test.ts without importing the whole
 * deploy entry, and so the "what does this tool actually do?" text is one
 * reviewable block.
 *
 * WHAT IS LISTED, AND WHY (UX ledger 1d — the help used to advertise 7 of the
 * bin's commands and omitted two that README told users to run):
 *
 *   Listed = every verb the bin's dispatcher routes. `create` comes FIRST under
 *   "Start here", because the reader who most needs help is the one who has not
 *   got an app yet.
 *
 *   NOT listed, deliberately:
 *     - `preview` (dist/cli/preview.js) — per-PR ephemeral environments, driven
 *       by .github/workflows/preview.yml, not typed by a human at a prompt.
 *     - `loadtest` (dist/cli/loadtest.js) — an operability/runbook tool (k6 Job,
 *       manual/nightly per its own header), not part of the deploy path.
 *   Both remain documented, directly-runnable entries (docs-site cli.mdx); they
 *   are excluded from the bin's help because they are not part of the surface a
 *   first-time user should be choosing from. {@link INTERNAL_ONLY_VERBS} pins
 *   that choice so it cannot rot into an accident.
 *
 *   Everything else under src/cli/ (cr-builder, exec, shared, validate, schema/,
 *   tracing-root) is a library module, not a verb. (`validate` the VERB is
 *   routed via validate-cmd.ts — validate.ts stays the load-time validation
 *   library that shared.ts and the public subpath import.)
 */

/**
 * Verbs that exist as runnable entries but are deliberately kept out of
 * `--help`. Asserted by cli-help-surface.test.ts, so adding one to the help
 * requires deleting it here — an explicit decision, never a drift.
 */
export const INTERNAL_ONLY_VERBS = ["preview", "loadtest"] as const;

/** Where a user with no Kubernetes background is sent for the long version. */
export const DOCS_URL = "https://knext.dev";

/** One row of the help's command list. */
export interface CliCommand {
    /**
     * The FIRST token the dispatcher matches — `db bind` and `db migrate` both
     * dispatch on `db`. This is also the allowlist entry used to reject an
     * unknown command (ADR-0046), so the help and the dispatcher cannot drift:
     * there is exactly one list.
     */
    verb: string;
    /** How the row reads in the help (`deploy (default)`, `db bind`). */
    display: string;
    summary: string;
}

export interface CliCommandGroup {
    heading: string;
    commands: readonly CliCommand[];
}

/**
 * The user-facing command surface, in the order a newcomer should meet it.
 * `create` leads because the reader who most needs help has no app yet.
 */
export const COMMAND_GROUPS: readonly CliCommandGroup[] = [
    {
        heading: "Start here",
        commands: [
            {
                verb: "create",
                display: "create",
                summary:
                    "scaffold a new knext-ready Next.js app (writes files only, no cluster changes)",
            },
            {
                verb: "validate",
                display: "validate",
                summary:
                    "check kn-next.config.ts is filled in and valid (reads only your config file — no cluster needed)",
            },
            {
                verb: "doctor",
                display: "doctor",
                summary:
                    "check the cluster has what knext needs (read-only; --json)",
            },
        ],
    },
    {
        heading: "Deploy and operate",
        commands: [
            {
                verb: "deploy",
                display: "deploy (default)",
                summary: "build → push → apply the NextApp CR",
            },
            {
                verb: "build",
                display: "build",
                summary:
                    "run the build + asset upload steps only, without deploying",
            },
            {
                verb: "status",
                display: "status",
                summary:
                    "show the NextApp's honest conditions (read-only; --json, --watch)",
            },
            {
                verb: "rollback",
                display: "rollback",
                summary:
                    "pin traffic to a prior Knative Revision (--to, --canary)",
            },
            {
                verb: "cleanup",
                display: "cleanup",
                summary:
                    "remove the app from the cluster (deletes its NextApp CR)",
            },
            {
                verb: "gc",
                display: "gc",
                summary:
                    "reap old _next/static/<build-id>/ asset prefixes (skew-protection GC)",
            },
        ],
    },
    {
        heading: "Database",
        commands: [
            {
                verb: "db",
                display: "db bind",
                summary: "bind an existing Postgres Secret to the NextApp CR",
            },
            {
                verb: "db",
                display: "db migrate",
                summary: "apply pending migrations against the writer, once",
            },
        ],
    },
];

/** Column width of the command column, so summaries line up. */
const DISPLAY_WIDTH = 18;

function renderCommandLines(): string[] {
    const lines: string[] = [];
    for (const group of COMMAND_GROUPS) {
        lines.push(`${group.heading}:`);
        for (const c of group.commands) {
            lines.push(`  ${c.display.padEnd(DISPLAY_WIDTH)}${c.summary}`);
        }
        lines.push("");
    }
    return lines;
}

export const CLI_HELP = `${[
    "kn-next — deploy Next.js apps to Kubernetes (Knative), scaled to zero when idle",
    "",
    "Usage: kn-next <command> [options]   (or: npx @getknext/core <command>)",
    "",
    ...renderCommandLines(),
    "Options (deploy):",
    "  -r, --registry  Container registry (overrides config)",
    "  -b, --bucket    Storage bucket (overrides config)",
    "  -t, --tag       Image tag (default: timestamp)",
    "  -n, --namespace Kubernetes namespace (default: default)",
    "  --skip-build    Skip next build step",
    "  --skip-upload   Skip asset upload step",
    "  --dry-run       Print the NextApp CR without applying it",
    "  -h, --help      Show this help",
    "  -v, --version   Print the kn-next version",
    "",
    "Examples:",
    "  kn-next create my-app   scaffold a new app in ./my-app",
    "  kn-next deploy          deploy the app in the current directory",
    "",
    `Docs: ${DOCS_URL}`,
].join("\n")}\n`;
