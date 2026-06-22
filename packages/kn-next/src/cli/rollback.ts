#!/usr/bin/env node

/**
 * kn-next rollback — shifts serving traffic to a prior Knative Revision by
 * patching the NextApp CR's spec.traffic (issue #92).
 *
 * Usage:
 *   kn-next rollback [<app>] --to <revision> [--canary <n>] [-n <namespace>]
 *   kn-next rollback [<app>]                  # revert to latest-ready (clear pin)
 *
 * ADR-0001 (operator = single source of truth):
 *   The CLI emits INTENT, it does NOT mutate the cluster out-of-band. Rollback
 *   issues ONLY `kubectl patch nextapp <name> --type merge -p <json>` — it NEVER
 *   writes the Knative Service / Route / `kn` directly. The operator reconciles
 *   spec.traffic into ksvc.Spec.Traffic. This mirrors how deploy.ts applies ONLY
 *   the CR and cleanup.ts deletes ONLY the CR.
 *
 *   Skew-protection note (#93): rollback only re-points SERVER traffic via a CR
 *   patch — it does NOT touch uploaded assets, so old revisions remain
 *   serviceable.
 */

import { createLogger } from "../utils/logger";
import { isEntrypoint, runQuiet } from "./exec";
// Single source of truth for config loading — also runs validateConfig.
import { loadConfig } from "./shared";

const log = createLogger({ module: "rollback" });

/**
 * Exec boundary: an injectable runner so tests can assert the EXACT argv issued
 * (and that NO ksvc/Route/Knative writes are emitted) without shelling out.
 * Production passes {@link runQuiet} (execFileSync, shell:false — CLI-58).
 */
export type RollbackExec = (argv: readonly string[]) => void;

/**
 * Build and run the rollback. Issues exactly ONE cluster write: a merge-patch of
 * the NextApp CR's spec.traffic.
 *
 *   - toRevision set  => pin spec.traffic.revisionName (+ optional canaryPercent).
 *   - toRevision unset => set spec.traffic to null (revert to latest-ready).
 *
 * The patch is serialized with JSON.stringify so it travels as ONE uninterpreted
 * argv token under shell:false — shell metacharacters can never inject.
 */
export function runRollback(
    appName: string,
    namespace: string,
    toRevision: string | undefined,
    canaryPercent: number | undefined,
    exec: RollbackExec = runQuiet,
): void {
    let patch: unknown;
    if (toRevision) {
        patch = {
            spec: {
                traffic: {
                    revisionName: toRevision,
                    ...(canaryPercent !== undefined ? { canaryPercent } : {}),
                },
            },
        };
    } else {
        // Revert to latest-ready: clear any prior pin.
        patch = { spec: { traffic: null } };
    }

    exec([
        "kubectl",
        "patch",
        "nextapp",
        appName,
        "-n",
        namespace,
        "--type",
        "merge",
        "-p",
        JSON.stringify(patch),
    ]);
}

interface RollbackArgs {
    app?: string;
    namespace: string;
    toRevision?: string;
    canaryPercent?: number;
}

/** Parse argv into rollback options. Positional <app> is optional. */
export function parseRollbackArgs(argv: readonly string[]): RollbackArgs {
    const out: RollbackArgs = { namespace: "default" };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--to") {
            out.toRevision = argv[++i];
        } else if (a === "--canary") {
            out.canaryPercent = Number(argv[++i]);
        } else if (a === "-n" || a === "--namespace") {
            out.namespace = argv[++i];
        } else if (!a.startsWith("-") && out.app === undefined) {
            out.app = a;
        }
    }
    return out;
}

async function rollback() {
    log.info("⏪ kn-next rollback");

    const args = parseRollbackArgs(process.argv.slice(2));

    // Resolve the app name: positional arg wins, else the config's name.
    let appName = args.app;
    if (!appName) {
        const config = await loadConfig();
        appName = config.name;
    }

    if (
        args.canaryPercent !== undefined &&
        (Number.isNaN(args.canaryPercent) ||
            args.canaryPercent < 0 ||
            args.canaryPercent > 100)
    ) {
        throw new Error("--canary must be an integer between 0 and 100");
    }

    log.info(
        {
            app: appName,
            namespace: args.namespace,
            toRevision: args.toRevision ?? "latest-ready",
            canaryPercent: args.canaryPercent,
        },
        "Patching NextApp CR spec.traffic (operator reconciles ksvc traffic)...",
    );

    runRollback(appName, args.namespace, args.toRevision, args.canaryPercent);

    log.info(
        { nextapp: appName },
        "Patched NextApp CR — operator will shift Knative revision traffic",
    );
    log.info("✨ Rollback complete!");
}

// Run only when invoked directly as the entry (not when imported, e.g. in tests).
if (isEntrypoint(import.meta.url)) {
    try {
        await rollback();
    } catch (err) {
        log.fatal({ err }, "Rollback failed");
        process.exit(1);
    }
}
