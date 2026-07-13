#!/usr/bin/env node

/**
 * kn-next gc — the skew-protection asset retention GC (#93, ADR-0011),
 * runnable standalone.
 *
 * This is the EXACT code path `kn-next deploy` runs after applying the CR
 * (extracted from deploy.ts so the e2e_gc suite — and an operator of the app
 * after a rollback — can drive it without a full build/push/deploy):
 *
 *   NextApp status.currentTraffic (READ-ONLY, #92)
 *     → parseLiveRevisionNames
 *       → resolve each live revision's `apps.kn-next.dev/build-id` label
 *         (READ-ONLY — the operator stamps it from spec.buildId, #93)
 *         → resolveLiveBuildIds — FAIL-SAFE: if ANY live revision cannot be
 *           resolved to a build-id, SKIP the GC entirely (over-keep, NEVER
 *           over-delete)
 *           → pruneOldBuilds: reap `<app>/_next/static/<id>/` prefixes that
 *             are outside the retain window AND not live. The bare `<app>/`
 *             prefix is teardown-only (ADR-0008) and never a prune target.
 *
 * ADR-0001: everything against the CLUSTER here is read-only — the CLI's only
 * mutations are against the app's own object-store prefix, which ADR-0011
 * already assigns to the CLI as the sole build-id-pruning authority.
 */

import { writeSync } from "node:fs";
import type { KnativeNextConfig } from "../config";
import { parseLiveRevisionNames, resolveLiveBuildIds } from "../utils/asset-gc";
import {
    BUILD_MARKER_FILENAME,
    type PruneSummary,
    pruneOldBuilds,
} from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import { runCapture } from "./exec";
// Single source of truth for config loading — also runs validateConfig.
import { loadConfig } from "./shared";

const log = createLogger({ module: "gc" });

/**
 * Exec boundary for the two READ-ONLY kubectl reads, injectable so tests can
 * assert the exact argv (and that nothing else is exec'd). Production passes
 * {@link runCapture} (execFileSync, shell:false — CLI-58).
 */
export type GcExec = (argv: readonly string[]) => string;

/** Prune boundary, injectable for tests. Production: {@link pruneOldBuilds}. */
export type GcPrune = typeof pruneOldBuilds;

export interface AssetGCResult {
    /** true ⇒ the prune ran; false ⇒ the fail-safe over-keep skip fired. */
    pruned: boolean;
    /** The revision names observed in status.currentTraffic (diagnostics). */
    liveRevisions: string[];
    /** Which fail-safe fired (only set when `pruned` is false). */
    skipReason?: "unresolvable-live-build-id" | "pinned-with-empty-status";
    /**
     * The `spec.traffic.revisionName` pin observed while status.currentTraffic
     * was empty (#264 fail-safe), or "(unreadable)" when the probe threw.
     */
    pinnedRevision?: string;
    /** What the prune did (only set when `pruned` is true). */
    summary?: PruneSummary;
}

/**
 * Runs the retention GC once. Shared verbatim by deploy.ts (post-deploy,
 * best-effort) and `kn-next gc` (standalone). Throws only when the
 * status.currentTraffic read itself fails — deploy wraps that in its
 * best-effort catch; `kn-next gc` lets it surface as a non-zero exit.
 */
export function runAssetGC(
    config: KnativeNextConfig,
    namespace: string,
    newBuildId: string,
    exec: GcExec = runCapture,
    prune: GcPrune = pruneOldBuilds,
): AssetGCResult {
    const trafficJson = exec([
        "kubectl",
        "get",
        "nextapp",
        config.name,
        "-n",
        namespace,
        "-o",
        "jsonpath={.status.currentTraffic}",
    ]);
    const liveRevisions = parseLiveRevisionNames(
        trafficJson.replace(/^'|'$/g, ""),
    );
    // #264 fail-safe: an EMPTY status.currentTraffic while the CR PINS a
    // revision (spec.traffic.revisionName set — a #92 rollback) means the
    // status was wiped or is lagging. A window-only prune here could reap the
    // pinned build's assets. Probe the spec (READ-ONLY) and skip loudly; a
    // failed probe also skips (we cannot prove there is no pin — over-keep,
    // never over-delete).
    if (liveRevisions.length === 0) {
        let pinned: string;
        try {
            pinned = exec([
                "kubectl",
                "get",
                "nextapp",
                config.name,
                "-n",
                namespace,
                "-o",
                "jsonpath={.spec.traffic.revisionName}",
            ])
                .replace(/^'|'$/g, "")
                .trim();
        } catch {
            pinned = "(unreadable)";
        }
        if (pinned) {
            return {
                pruned: false,
                liveRevisions,
                skipReason: "pinned-with-empty-status",
                pinnedRevision: pinned,
            };
        }
    }
    // Resolve each live revision to its build-id via the operator-stamped
    // label (read-only). The single-token jsonpath escapes the dotted/slashed
    // label key. A missing label yields '' → resolveLiveBuildIds fails safe.
    const resolved = resolveLiveBuildIds(liveRevisions, (rev) =>
        exec([
            "kubectl",
            "get",
            "revision",
            rev,
            "-n",
            namespace,
            "-o",
            "jsonpath={.metadata.labels.apps\\.kn-next\\.dev/build-id}",
        ])
            .replace(/^'|'$/g, "")
            .trim(),
    );
    if (!resolved.ok) {
        return {
            pruned: false,
            liveRevisions,
            skipReason: "unresolvable-live-build-id",
        };
    }
    const summary = prune(config, resolved.buildIds, newBuildId);
    return { pruned: true, liveRevisions, summary };
}

export interface GcArgs {
    namespace: string;
    /**
     * The build-id to treat as the unambiguous newest (deploy passes the tag
     * it just shipped). Empty ⇒ the retain window falls back to the remote
     * listing order alone.
     */
    buildId: string;
}

/**
 * Parse argv into gc options. STRICT by design (same contract as rollback):
 * gc DELETES object-store prefixes, so a typo'd flag must be a hard error,
 * never a silent fall-through with different retention semantics.
 */
export function parseGcArgs(argv: readonly string[]): GcArgs {
    const out: GcArgs = { namespace: "default", buildId: "" };
    const takeValue = (flag: string, i: number): string => {
        const v = argv[i];
        if (v === undefined || v.startsWith("-")) {
            throw new Error(`${flag} requires a value (see kn-next gc --help)`);
        }
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--build-id") {
            out.buildId = takeValue("--build-id", ++i);
        } else if (a === "-n" || a === "--namespace") {
            out.namespace = takeValue(a, ++i);
        } else if (a.startsWith("-")) {
            throw new Error(`unknown flag "${a}" (see kn-next gc --help)`);
        } else {
            throw new Error(
                `unexpected positional ${JSON.stringify(a)} — the app comes from kn-next.config.ts (see kn-next gc --help)`,
            );
        }
    }
    return out;
}

const GC_HELP = `kn-next gc — reap old \`_next/static/<build-id>/\` asset prefixes (skew protection)

Runs the SAME retention GC \`kn-next deploy\` runs after shipping (ADR-0011):
keeps the newest \`storage.assetRetention\` build-ids (default 3) PLUS every
build-id currently serving traffic (resolved read-only from the NextApp's
status.currentTraffic via the operator-stamped \`apps.kn-next.dev/build-id\`
revision label) — a pinned/canary/rolled-back revision's assets are NEVER
reaped. FAIL-SAFE: if any live revision has no resolvable build-id, or the CR
pins a revision (spec.traffic.revisionName) while status.currentTraffic is
empty (status wiped/lagging), the GC is skipped entirely
(over-keep, never over-delete). The bare \`<app>/\` prefix is teardown-only
(ADR-0008) and never touched.

MARKER INVERSION: only prefixes carrying the \`.knext-build\` marker object
(written by every \`kn-next\` upload at \`_next/static/<id>/.knext-build\`) are
ever reap candidates — unknown/future dirs default to KEEP. Builds uploaded by
a pre-marker kn-next are therefore never reaped until a marker-carrying
re-upload; such kept prefixes are named in the output, and reclaiming a
retired app's pre-marker prefixes is a manual delete (or deleting the NextApp,
whose teardown finalizer wipes the whole \`<app>/\` namespace).

The app + storage come from kn-next.config.ts in the current directory.

Usage:
  kn-next gc [--build-id <id>] [-n <namespace>]

Options:
  --build-id <id>       Build-id to treat as the newest (e.g. the tag just
                        deployed). Omit to order by the remote listing alone.
  -n, --namespace <ns>  Kubernetes namespace of the NextApp (default: default)
  -h, --help            Show this help
`;

/** Entry for \`kn-next gc\`. Returns the process exit code. */
export async function gcMain(argv: readonly string[]): Promise<number> {
    if (argv.includes("-h") || argv.includes("--help")) {
        // Written synchronously to fd 1 (not via the async pino transport) so
        // `kn-next gc --help | cat` is never truncated — same contract as the
        // rollback/status/doctor help paths.
        writeSync(1, GC_HELP);
        return 0;
    }

    const args = parseGcArgs(argv);
    const config = await loadConfig();

    log.info(
        { app: config.name, namespace: args.namespace, buildId: args.buildId },
        "Running asset retention GC (read-only against the cluster)...",
    );

    const res = runAssetGC(config, args.namespace, args.buildId);

    // Synchronous outcome line on fd 1: pino's transport is async and a
    // process.exit right after can swallow it — a command that may have
    // DELETED objects must always print what it did.
    if (res.pruned) {
        // Unmarked prefixes were skipped LOUDLY, by name (#264 marker
        // inversion — pre-marker uploads / unknown dirs are over-kept).
        const keptUnmarked = res.summary?.keptUnmarked ?? [];
        const unmarkedNote =
            keptUnmarked.length > 0
                ? `; unmarked prefixes kept (no ${BUILD_MARKER_FILENAME} marker — ` +
                  `pre-marker upload or unknown dir): [${keptUnmarked.join(", ")}]`
                : "";
        writeSync(
            1,
            `gc: completed for ${config.name} (ns ${args.namespace}) — ` +
                `live revisions protected: [${res.liveRevisions.join(", ")}]` +
                `; reaped: [${(res.summary?.reaped ?? []).join(", ")}]` +
                `${unmarkedNote}\n`,
        );
    } else if (res.skipReason === "pinned-with-empty-status") {
        writeSync(
            1,
            `gc: SKIPPED (fail-safe over-keep) — ${config.name} pins revision ` +
                `"${res.pinnedRevision}" (spec.traffic.revisionName) but ` +
                `status.currentTraffic is empty (status wiped or lagging); a ` +
                `window-only prune could reap the pinned build. Nothing was deleted.\n`,
        );
    } else {
        writeSync(
            1,
            `gc: SKIPPED (fail-safe over-keep) — a live revision of ${config.name} ` +
                `has no resolvable build-id label; nothing was deleted. ` +
                `live revisions: [${res.liveRevisions.join(", ")}]\n`,
        );
    }
    return 0;
}

// NO self-entry block here, DELIBERATELY (unlike rollback.ts/cleanup.ts).
// deploy.ts imports runAssetGC STATICALLY; if this module also carried an
// `isEntrypoint(import.meta.url)` entry block, any bundling change that
// inlines it into the bin (where import.meta.url == the bin's URL) would
// fire gcMain at module load and hijack every subcommand — observed live
// when the dispatcher's dynamic `import("./gc")` was the only thing keeping
// tsup from inlining this module. The `kn-next gc` dispatcher branch is this
// module's ONLY entry (pinned hermetically by cli-node-runtime.test.ts).
