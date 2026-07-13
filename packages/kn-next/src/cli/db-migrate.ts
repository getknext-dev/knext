#!/usr/bin/env node

/**
 * kn-next db migrate — the one-shot, writer-only migration runner (ADR-0021 §3).
 *
 * Usage:
 *   kn-next db migrate [--url <dsn>] [--dir <path>] [--migrations <path>]
 *
 * Applies drizzle-kit-generated migrations against the **writer** `DATABASE_URL`
 * exactly once per deploy — a CI step or a pre-deploy k8s Job — and exits. This
 * is the k8s-idiomatic answer to "who migrates a single-writer, scale-to-zero
 * DB?":
 *
 *   - **Writer-only.** Resolves `DATABASE_URL` (never `DATABASE_URL_RO`); the
 *     `@knext/db` engine refuses a read-replica DSN (ADR-0021 §3).
 *   - **Out of the request path.** Runs once, not on every pod boot — no N-pod
 *     migrator race, no cold-start penalty. Not operator-run (migrating app data
 *     is not a cluster-resource mutation; the operator owns ksvc/Secrets, not
 *     schemas — ADR-0001 boundary).
 *   - **Idempotent + fail loud.** drizzle tracks applied migrations, so a re-run
 *     is a no-op; a migration error exits **non-zero** so a Job fails loud.
 *
 * The migration engine lives in `@knext/db/migrate` (`runMigrations`); this
 * module is the thin CLI over it. Connecting wakes the writer once — a deliberate
 * one-shot, the intended interaction with scale-to-zero.
 */

import { writeSync } from "node:fs";
import { createLogger } from "../utils/logger";

const log = createLogger({ module: "db-migrate" });

/** Parsed `kn-next db migrate` flags (after the `db migrate` words). */
export interface DbMigrateOptions {
    /** Writer DSN override; defaults downstream to `DATABASE_URL`. */
    url?: string;
    /** Migrations directory; defaults downstream to `./drizzle`. */
    migrationsFolder?: string;
}

/**
 * The migration engine's shape (`@knext/db/migrate`'s `runMigrations`), injected
 * so the CLI is unit-testable without a database or the `@knext/db` build.
 */
export type MigrateRunner = (opts: {
    url?: string;
    migrationsFolder?: string;
}) => Promise<{ migrationsFolder: string }>;

/** Parse `kn-next db migrate` argv. Fails loud on unknown flags / stray args. */
export function parseDbMigrateArgs(argv: readonly string[]): DbMigrateOptions {
    const out: DbMigrateOptions = {};
    // A value-taking flag must actually carry a value: a trailing `--url`, or one
    // followed by another flag, is a usage error — not a silent `undefined` that
    // detonates later inside the DSN resolver.
    const need = (flag: string, i: number): string => {
        const v = argv[i];
        if (v === undefined || v.startsWith("-")) {
            throw new Error(
                `${flag} requires a value (see kn-next db migrate --help)`,
            );
        }
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--url") {
            out.url = need(a, ++i);
        } else if (a === "--dir" || a === "--migrations") {
            out.migrationsFolder = need(a, ++i);
        } else if (a.startsWith("-")) {
            // A typo like `--dsn` must not silently migrate with defaults.
            throw new Error(
                `unknown flag "${a}" (see kn-next db migrate --help)`,
            );
        } else {
            throw new Error(
                `unexpected positional "${a}" — kn-next db migrate takes no positionals (see kn-next db migrate --help)`,
            );
        }
    }
    return out;
}

export const DB_MIGRATE_HELP = `kn-next db migrate — apply pending migrations against the writer, once (ADR-0021 §3)

Usage:
  kn-next db migrate [options]

Runs drizzle-kit-generated migrations against the WRITER DATABASE_URL exactly
once per deploy (a CI step or a pre-deploy k8s Job), out of the request path.
Writer-only (never DATABASE_URL_RO), idempotent, and fail-loud (a failure exits
non-zero so a Job fails). Connecting wakes a scale-to-zero writer once.

Options:
  --url <dsn>          Writer DSN override (default: DATABASE_URL). Never the RO replica.
  --dir <path>         Migrations directory (default: ./drizzle)
  --migrations <path>  Alias for --dir
  -h, --help           Show this help
`;

/** The default runner: the `@knext/db/migrate` engine (real pg + drizzle). */
const defaultRun: MigrateRunner = async (opts) => {
    const { runMigrations } = await import("@knext/db/migrate");
    return runMigrations(opts);
};

/**
 * Run `kn-next db migrate`. The engine (`run`) and stdout (`write`) are injected
 * so the CLI is testable without a database; production wires the real
 * `@knext/db` runner and `writeSync(1, …)`. A runner failure PROPAGATES so the
 * bin's dispatcher exits non-zero — a Job must fail loud.
 */
export async function runDbMigrate(
    argv: readonly string[],
    run: MigrateRunner = defaultRun,
    write: (text: string) => void = (t) => writeSync(1, t),
): Promise<void> {
    if (argv.includes("-h") || argv.includes("--help")) {
        write(DB_MIGRATE_HELP);
        return;
    }
    const opts = parseDbMigrateArgs(argv);

    log.info(
        { dir: opts.migrationsFolder ?? "./drizzle" },
        "kn-next db migrate (writer-only, one-shot — waking the writer once)",
    );

    const result = await run({
        url: opts.url,
        migrationsFolder: opts.migrationsFolder,
    });

    write(
        `Migrations applied from ${result.migrationsFolder} (idempotent — already-applied migrations skipped).\n`,
    );
    log.info({ dir: result.migrationsFolder }, "Migrations applied");
}

// NO self-entry block here, DELIBERATELY — this module is reached ONLY via
// the kn-next bin's subcommand dispatch (see the hazard note atop deploy.ts's
// dispatcher: an isEntrypoint block in a bin-dispatched module re-arms the
// tsup-inlining hijack, #263).
