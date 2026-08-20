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
 *   tracing-root) is a library module, not a verb.
 */

/**
 * Verbs that exist as runnable entries but are deliberately kept out of
 * `--help`. Asserted by cli-help-surface.test.ts, so adding one to the help
 * requires deleting it here — an explicit decision, never a drift.
 */
export const INTERNAL_ONLY_VERBS = ["preview", "loadtest"] as const;

/** Where a user with no Kubernetes background is sent for the long version. */
export const DOCS_URL = "https://knext.dev";

export const CLI_HELP = `${[
    "kn-next — deploy Next.js apps to Kubernetes (Knative), scaled to zero when idle",
    "",
    "Usage: kn-next <command> [options]   (or: npx @getknext/core <command>)",
    "",
    "Start here:",
    "  create            scaffold a new knext-ready Next.js app (writes files only, no cluster changes)",
    "  doctor            check the cluster has what knext needs (read-only; --json)",
    "",
    "Deploy and operate:",
    "  deploy (default)  build → push → apply the NextApp CR",
    "  build             run the build + asset upload steps only, without deploying",
    "  status            show the NextApp's honest conditions (read-only; --json, --watch)",
    "  rollback          pin traffic to a prior Knative Revision (--to, --canary)",
    "  cleanup           remove the app from the cluster (deletes its NextApp CR)",
    "  gc                reap old _next/static/<build-id>/ asset prefixes (skew-protection GC)",
    "",
    "Database:",
    "  db bind           bind an existing Postgres Secret to the NextApp CR",
    "  db migrate        apply pending migrations against the writer, once",
    "",
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
