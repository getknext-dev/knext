#!/usr/bin/env node

/**
 * kn-next cleanup — tears down a deployed app by deleting its NextApp CR.
 *
 * Usage:
 *   node packages/kn-next/src/cli/cleanup.ts
 *
 * ADR-0001 (operator = single source of truth) + issue #74:
 *   The CLI emits INTENT, it does NOT mutate the cluster out-of-band. Teardown
 *   issues ONLY `kubectl delete nextapp <name>` — mirroring how deploy.ts applies
 *   ONLY the CR. Everything else is the operator's job:
 *     - Owned k8s children (ksvc / ServiceAccount / PVC) are removed by
 *       ownerReference garbage-collection.
 *     - External state (object-store prefix + Redis keyspace) is cleared by the
 *       operator's `apps.kn-next.dev/external-cleanup` finalizer, scoped strictly
 *       to this app's prefix/keyPrefix (cross-app data-sovereignty safety).
 *   The CLI therefore NO LONGER deletes ksvc/SA/PVC/statefulset/svc directly, and
 *   NO LONGER shells out to gsutil/aws/mc/az to clear buckets. Doing so would
 *   reintroduce the "second cluster writer" violation #33 fixed for deploy.
 */

import { writeSync } from "node:fs";
import type { KnativeNextConfig } from "../config";
import { createLogger } from "../utils/logger";
import { isEntrypoint, runQuiet } from "./exec";
// Single source of truth for config loading — also runs validateConfig.
import { handleConfigNotFound, loadConfig } from "./shared";

const log = createLogger({ module: "cleanup" });

/**
 * Exec boundary: an injectable runner so tests can assert the EXACT argv issued
 * (and that NO storage/child-object deletes are emitted) without shelling out.
 * Production passes {@link runQuiet} (execFileSync, shell:false — CLI-58).
 */
export type CleanupExec = (argv: readonly string[]) => void;

/**
 * Build and run the teardown. Issues exactly ONE cluster write: deleting the
 * NextApp CR. The operator's finalizer handles the rest of teardown.
 *
 * `--ignore-not-found` keeps re-runs idempotent (no error if already deleted).
 */
export function runCleanup(
    config: KnativeNextConfig,
    exec: CleanupExec = runQuiet,
): void {
    exec(["kubectl", "delete", "nextapp", config.name, "--ignore-not-found"]);
}

/**
 * Tear down the app described by the local kn-next.config.ts. Exported so the
 * `kn-next cleanup` bin subcommand can dispatch to it (the module also remains
 * a documented directly-runnable entry — see the self-entry block below).
 */
export async function cleanup() {
    log.info("🧹 kn-next cleanup");

    log.info("Loading configuration...");
    const config = await loadConfig();
    log.info({ app: config.name }, "Configuration loaded");

    log.info("Deleting NextApp CR (operator finalizer clears the rest)...");
    runCleanup(config);
    log.info(
        { nextapp: config.name },
        "Deleted NextApp CR — operator will GC children and clear external state",
    );

    log.info("✨ Cleanup complete!");
}

const CLEANUP_HELP = `kn-next cleanup — remove the app in this directory from the cluster

Usage:
  kn-next cleanup

Issues exactly ONE cluster write: \`kubectl delete nextapp <name>\` for the app
named in kn-next.config.ts. Owned resources (Knative Service, ServiceAccount,
PVC) go with it via owner-reference garbage collection, and the operator's
finalizer clears this app's object-store prefix and Redis keyspace.

This is DESTRUCTIVE and takes no options — a stray flag is an error, never an
ignored argument.

Options:
  -h, --help            Show this help
`;

/**
 * argv entry for `kn-next cleanup`.
 *
 * Exists because the first version of the dispatch branch called `cleanup()`
 * with no argument parsing at all: `kn-next cleanup --help` DELETED the app
 * instead of printing help (reproduced by a reviewer against a live CR). Any
 * argument other than the help flags is now a hard error — for a destructive
 * verb, "ignored the flag and did it anyway" is the worst possible reading.
 */
export async function cleanupMain(argv: readonly string[]): Promise<number> {
    if (argv.includes("-h") || argv.includes("--help")) {
        writeSync(1, CLEANUP_HELP);
        return 0;
    }
    const stray = argv[0];
    if (stray !== undefined) {
        throw new Error(
            stray.startsWith("-")
                ? `unknown flag "${stray}" — kn-next cleanup takes no options (see kn-next cleanup --help)`
                : `unexpected positional ${JSON.stringify(stray)} — the app comes from kn-next.config.ts (see kn-next cleanup --help)`,
        );
    }
    await cleanup();
    return 0;
}

// Run only when invoked directly as the entry (not when imported, e.g. in tests).
// SANCTIONED self-entry (#263): this is a DOCUMENTED directly-runnable entry
// (docs-site cli.mdx "Directly runnable entries") with its own tsup entry, so
// it is never inlined into the bin. See the hazard note atop deploy.ts's
// dispatcher before adding self-entry blocks anywhere else.
// Routed through cleanupMain so the direct entry honours --help too.
if (isEntrypoint(import.meta.url)) {
    try {
        process.exit(await cleanupMain(process.argv.slice(2)));
    } catch (err) {
        // Expected state, not a crash — see the note in deploy.ts's dispatcher.
        if (handleConfigNotFound(err)) {
            process.exit(1);
        }
        log.fatal({ err }, "Cleanup failed");
        process.exit(1);
    }
}
