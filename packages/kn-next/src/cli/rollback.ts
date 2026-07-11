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

import { writeSync } from "node:fs";
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

/**
 * Parse argv into rollback options. Positional <app> is optional.
 *
 * STRICT by design (PR #232 review): rollback is a MUTATING command whose
 * bare form (`kn-next rollback <app>`) clears the traffic pin — so a dangling
 * `--to` or a typo'd flag must be a hard error, never a silent fall-through
 * to the OPPOSITE mutation (un-pinning when the user asked to pin).
 */
export function parseRollbackArgs(argv: readonly string[]): RollbackArgs {
    const out: RollbackArgs = { namespace: "default" };
    const takeValue = (flag: string, i: number): string => {
        const v = argv[i];
        if (v === undefined || v.startsWith("-")) {
            throw new Error(
                `${flag} requires a value (see kn-next rollback --help)`,
            );
        }
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--to") {
            out.toRevision = takeValue("--to", ++i);
        } else if (a === "--canary") {
            const raw = takeValue("--canary", ++i);
            const n = Number(raw);
            // Integer 1–99 only — matches the help text. 0 is NOT "no canary"
            // (omit the flag for that) and 100 would send everything back to
            // latest-ready, i.e. not a rollback at all.
            if (!Number.isInteger(n) || n < 1 || n > 99) {
                throw new Error(
                    `--canary must be an integer between 1 and 99 (got ${JSON.stringify(raw)})`,
                );
            }
            out.canaryPercent = n;
        } else if (a === "-n" || a === "--namespace") {
            out.namespace = takeValue(a, ++i);
        } else if (a.startsWith("-")) {
            throw new Error(
                `unknown flag "${a}" (see kn-next rollback --help)`,
            );
        } else if (out.app === undefined) {
            out.app = a;
        } else {
            throw new Error(
                `unexpected positional ${JSON.stringify(a)} — only one <app> positional is accepted (see kn-next rollback --help)`,
            );
        }
    }
    if (out.canaryPercent !== undefined && out.toRevision === undefined) {
        throw new Error(
            "--canary requires --to <revision> (see kn-next rollback --help)",
        );
    }
    return out;
}

const ROLLBACK_HELP = `kn-next rollback — shift serving traffic to a prior Knative Revision

Patches ONLY the NextApp CR's spec.traffic (one kubectl merge-patch); the
operator reconciles the ksvc traffic split (ADR-0001). Uploaded assets are
untouched, so the rolled-away revision remains serviceable (#93 skew note).

Usage:
  kn-next rollback [<app>] --to <revision> [--canary <n>] [options]
  kn-next rollback [<app>]                  # clear the pin (back to latest-ready)

Options:
  --to <revision>       Prior Knative Revision to pin (e.g. my-app-00001).
                        Omit to clear any pin and revert to latest-ready.
  --canary <n>          With --to: send n% (1-99) of traffic to latest-ready,
                        (100-n)% to the pinned revision
  -n, --namespace <ns>  Kubernetes namespace (default: default)
  -h, --help            Show this help
`;

/** Entry for \`kn-next rollback\`. Returns the process exit code. */
export async function rollbackMain(argv: readonly string[]): Promise<number> {
    if (argv.includes("-h") || argv.includes("--help")) {
        // Written synchronously to fd 1 (not via the async pino transport) so
        // `kn-next rollback --help | cat` is never truncated — same contract as
        // the status/doctor help paths.
        writeSync(1, ROLLBACK_HELP);
        return 0;
    }
    await rollback(argv);
    return 0;
}

async function rollback(argv: readonly string[]) {
    log.info("⏪ kn-next rollback");

    const args = parseRollbackArgs(argv);

    // Resolve the app name: positional arg wins, else the config's name.
    // (Canary/flag validation already happened in parseRollbackArgs — strict,
    // integer 1–99, no unknown flags.)
    let appName = args.app;
    if (!appName) {
        const config = await loadConfig();
        appName = config.name;
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

    // Synchronous one-line confirmation on fd 1: pino's transport is async and
    // a process.exit right after can swallow the log lines above — a SUCCESSFUL
    // mutation must always print what it did (same writeSync contract as help).
    writeSync(
        1,
        args.toRevision
            ? `rollback: pinned ${appName} (ns ${args.namespace}) spec.traffic to ${args.toRevision}` +
                  (args.canaryPercent !== undefined
                      ? ` with canary ${args.canaryPercent}% to latest-ready`
                      : "") +
                  " — operator reconciles the ksvc split\n"
            : `rollback: cleared ${appName} (ns ${args.namespace}) spec.traffic pin — back to latest-ready\n`,
    );
}

// Run only when invoked directly as the entry (not when imported by tests or
// the kn-next bin dispatcher).
if (isEntrypoint(import.meta.url)) {
    try {
        process.exit(await rollbackMain(process.argv.slice(2)));
    } catch (err) {
        log.fatal({ err }, "Rollback failed");
        process.exit(1);
    }
}
