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
 * The machine-readable skip-reason TOKEN REGISTRY for the asset-GC fail-safe
 * over-keep skips (v3-P4a, ADR-0011).
 *
 * These tokens are a PUBLIC, STABLE contract: they are emitted verbatim inside
 * the `[<token>]` suffix of the `gc: SKIPPED (fail-safe over-keep) [<token>]`
 * line, which operators match on to alert / build dashboards / key runbooks.
 * Treat them like an enum — do NOT rename a token casually; a rename is a
 * breaking change to every consumer that greps for it. Adding a NEW skip cause
 * means adding a token HERE and a render case in {@link renderGcReport} (the
 * `never`-exhaustiveness check there forces this — a new cause without a token
 * + render fails to compile, so a future skip can never silently mislabel).
 *
 * FIRST-CAUSE PRECEDENCE. When more than one skip condition could hold at once
 * (e.g. the spec-pin probe threw AND a live revision's build-id label is also
 * unresolvable), the token reflects the FIRST cause checked in
 * {@link runAssetGC}. The check order — and therefore the precedence — is:
 *
 *   1. `pinned-with-empty-status`   — status.currentTraffic is empty while the
 *      CR pins a revision (spec.traffic.revisionName set), OR the pin probe
 *      itself threw while the status was empty. A window-only prune here could
 *      reap the pinned build. (Highest precedence.)
 *   2. `pinned-not-resolvable`      — with a NON-empty (possibly lagging)
 *      status, the pin probe threw (cannot prove there is no pin), OR the pin
 *      is outside currentTraffic and its build-id cannot be resolved (revision
 *      gone / label absent / read failed). Decided BEFORE per-live-revision
 *      label resolution.
 *   3. `unresolvable-live-build-id` — a live revision has no resolvable
 *      build-id label (missing, empty, or the read threw).
 *   4. `traffic-drift-during-plan` — the pin or status.currentTraffic changed
 *      between the plan and the pre-delete re-read (or the re-read itself
 *      failed), so the computed delete set may no longer be safe (v3-P4b TOCTOU
 *      narrowing). This is checked LAST — it is only reachable once the plan has
 *      already resolved to a concrete, prunable delete set (all three fail-safes
 *      above passed), so it has the LOWEST precedence. See {@link runAssetGC}.
 */
export const GC_SKIP_REASONS = {
    "pinned-with-empty-status": "pinned-with-empty-status",
    "pinned-not-resolvable": "pinned-not-resolvable",
    "unresolvable-live-build-id": "unresolvable-live-build-id",
    "traffic-drift-during-plan": "traffic-drift-during-plan",
} as const;

/** A stable machine-readable GC skip-reason token (see {@link GC_SKIP_REASONS}). */
export type GcSkipReason =
    (typeof GC_SKIP_REASONS)[keyof typeof GC_SKIP_REASONS];

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
    /**
     * Which fail-safe fired (only set when `pruned` is false), as a STABLE
     * machine-readable token from {@link GC_SKIP_REASONS}. Rendered into the
     * `[<token>]` suffix of the SKIPPED line by {@link renderGcReport}.
     */
    skipReason?: GcSkipReason;
    /**
     * The `spec.traffic.revisionName` pin observed by the UNCONDITIONAL spec
     * probe (#272 residual — set on both pin fail-safes), or "(unreadable)"
     * when the probe threw.
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
 *
 * With `dryRun` (#264 part 2) the cluster reads and the plan computation are
 * IDENTICAL; only the deletes are withheld (see pruneOldBuilds).
 *
 * TOCTOU (v3-P4b — NARROWED, NOT eliminated; ADR-0011 §TOCTOU): the plan
 * (status/spec reads → protected-set computation) and the prune's delete
 * execution are not atomic. To shrink the window, this run RE-READS the pin +
 * status.currentTraffic ONCE immediately before the first delete and ABORTS
 * (fail-safe over-keep — nothing deleted, [traffic-drift-during-plan]) on ANY
 * drift: drift = (pin₂ ≠ pin₁) OR (currentTraffic₂ revision SET ≠
 * currentTraffic₁ set, order-insensitive). A re-read that itself fails is
 * treated as drift (over-keep, never over-delete). This NARROWS but does NOT
 * close the window — a change after the second read and before the physical
 * delete is still possible; object stores offer no atomic compare-and-delete
 * across the set. The re-read only ever makes the GC MORE conservative
 * (abort/keep) — it can never cause a delete the original plan would have kept.
 */
function readCurrentTrafficRevisions(
    exec: GcExec,
    config: KnativeNextConfig,
    namespace: string,
): string[] {
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
    return parseLiveRevisionNames(trafficJson.replace(/^'|'$/g, ""));
}

/**
 * Reads `spec.traffic.revisionName` (READ-ONLY). Returns `{ ok:false }` when
 * the probe throws — the plan path treats that as "cannot prove there is no
 * pin" (over-keep), and the re-read path treats it as drift (over-keep).
 */
function readSpecPin(
    exec: GcExec,
    config: KnativeNextConfig,
    namespace: string,
): { ok: true; pin: string } | { ok: false } {
    try {
        const pin = exec([
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
        return { ok: true, pin };
    } catch {
        return { ok: false };
    }
}

export function runAssetGC(
    config: KnativeNextConfig,
    namespace: string,
    newBuildId: string,
    exec: GcExec = runCapture,
    prune: GcPrune = pruneOldBuilds,
    dryRun = false,
): AssetGCResult {
    // ── PLAN PHASE ── first observation of pin + status.currentTraffic; compute
    // the concrete delete set (via the prune's classify path) but DO NOT delete
    // until the re-read below confirms no drift.
    const liveRevisions = readCurrentTrafficRevisions(exec, config, namespace);
    // Spec-pin probe — UNCONDITIONAL (#272 sysdesign-gate residual, folded
    // into #254): status.currentTraffic is the operator's OBSERVATION and can
    // LAG the spec — a fresh `kn-next rollback --to revA` pin may not be
    // reflected in a still-populated (or wiped) status yet. The pin is
    // therefore read on EVERY run (READ-ONLY): an empty status with a pin
    // skips (#264 fail-safe below); a populated status has the pin's build-id
    // unioned into the protected set after live resolution. A failed probe is
    // treated as "cannot prove there is no pin" — over-keep, never over-delete.
    const pin1 = readSpecPin(exec, config, namespace);
    const pinProbeFailed = !pin1.ok;
    const pinnedRevision = pin1.ok ? pin1.pin : "(unreadable)";
    // #264 fail-safe: an EMPTY status.currentTraffic while the CR PINS a
    // revision (spec.traffic.revisionName set — a #92 rollback) means the
    // status was wiped or is lagging. A window-only prune here could reap the
    // pinned build's assets — skip loudly (a failed probe lands here too).
    if (liveRevisions.length === 0 && pinnedRevision) {
        return {
            pruned: false,
            liveRevisions,
            skipReason: "pinned-with-empty-status",
            pinnedRevision,
        };
    }
    // #272 residual: with a NON-empty (possibly lagging) status, the spec pin
    // must still be protected. A failed probe means we cannot prove there is
    // no pin — fail-safe skip BEFORE the per-revision label reads below (the
    // skip is already decided, so the N reads would be pointless work).
    if (pinProbeFailed) {
        return {
            pruned: false,
            liveRevisions,
            skipReason: "pinned-not-resolvable",
            pinnedRevision,
        };
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
    // A pin outside currentTraffic is resolved via the SAME operator-stamped
    // label read the live revisions use and its build-id unioned into the
    // protected set; an unresolvable pin (revision gone / label missing /
    // read failed) fail-safe skips.
    let liveBuildIds = resolved.buildIds;
    if (pinnedRevision && !liveRevisions.includes(pinnedRevision)) {
        let pinnedBuildId = "";
        try {
            pinnedBuildId = exec([
                "kubectl",
                "get",
                "revision",
                pinnedRevision,
                "-n",
                namespace,
                "-o",
                "jsonpath={.metadata.labels.apps\\.kn-next\\.dev/build-id}",
            ])
                .replace(/^'|'$/g, "")
                .trim();
        } catch {
            pinnedBuildId = "";
        }
        if (!pinnedBuildId) {
            return {
                pruned: false,
                liveRevisions,
                skipReason: "pinned-not-resolvable",
                pinnedRevision,
            };
        }
        if (!liveBuildIds.includes(pinnedBuildId)) {
            liveBuildIds = [...liveBuildIds, pinnedBuildId];
        }
    }

    // ── TOCTOU RE-READ (v3-P4b) ── the plan is now a concrete, prunable delete
    // set. RE-READ the pin + status.currentTraffic ONCE more immediately before
    // the first delete and ABORT on ANY drift (fail-safe over-keep). This is the
    // LAST skip cause — only reachable once the three plan-phase fail-safes
    // passed — so it never overwrites an earlier skip's token.
    //
    // A dry-run computes the plan but issues ZERO deletes, so there is no delete
    // to guard: the re-read is skipped (it would be pointless cluster reads and
    // would change the argv-count contract the --dry-run tests pin).
    if (
        !dryRun &&
        driftedSincePlan(exec, config, namespace, liveRevisions, pin1)
    ) {
        return {
            pruned: false,
            liveRevisions,
            skipReason: "traffic-drift-during-plan",
            pinnedRevision,
        };
    }

    const summary = prune(config, liveBuildIds, newBuildId, { dryRun });
    return { pruned: true, liveRevisions, summary };
}

/**
 * The pre-delete TOCTOU re-read (v3-P4b). Observes the pin + currentTraffic a
 * SECOND time and returns true iff there is drift vs the plan-phase observation:
 *
 *   drift = (pin₂ ≠ pin₁) OR (currentTraffic₂ revision SET ≠ plan set)
 *
 * The currentTraffic comparison is a SET comparison (order-insensitive) —
 * duplicates collapse and re-ordering is not drift. HARD SAFETY INVARIANT: a
 * re-read that itself FAILS (either read throws) returns `true` (drift/abort),
 * never `false` — the re-read may only ever make the GC more conservative.
 */
function driftedSincePlan(
    exec: GcExec,
    config: KnativeNextConfig,
    namespace: string,
    planRevisions: readonly string[],
    planPin: { ok: true; pin: string } | { ok: false },
): boolean {
    let revisions2: string[];
    const pin2 = readSpecPin(exec, config, namespace);
    try {
        revisions2 = readCurrentTrafficRevisions(exec, config, namespace);
    } catch {
        // Re-read failed → cannot prove no drift → fail-safe abort (over-keep).
        return true;
    }
    // A re-read pin probe that threw is itself drift (cannot prove no change).
    if (!pin2.ok) return true;
    // Pin value changed (including "" ⇄ set) ⇒ drift.
    if (!planPin.ok || pin2.pin !== planPin.pin) return true;
    // currentTraffic revision SET changed (order-insensitive) ⇒ drift.
    const before = new Set(planRevisions);
    const after = new Set(revisions2);
    if (before.size !== after.size) return true;
    for (const r of after) {
        if (!before.has(r)) return true;
    }
    return false;
}

export interface GcArgs {
    namespace: string;
    /**
     * The build-id to treat as the unambiguous newest (deploy passes the tag
     * it just shipped). Empty ⇒ the retain window falls back to the remote
     * listing order alone.
     */
    buildId: string;
    /**
     * `--dry-run` (#264 part 2): compute + print the full reap/keep plan,
     * issue ZERO deletes. Composes with --build-id/-n.
     */
    dryRun: boolean;
}

/**
 * Parse argv into gc options. STRICT by design (same contract as rollback):
 * gc DELETES object-store prefixes, so a typo'd flag must be a hard error,
 * never a silent fall-through with different retention semantics.
 */
export function parseGcArgs(argv: readonly string[]): GcArgs {
    const out: GcArgs = { namespace: "default", buildId: "", dryRun: false };
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
        } else if (a === "--dry-run") {
            out.dryRun = true;
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
revision label) PLUS the build of any \`spec.traffic.revisionName\` pin (read
unconditionally — a populated status can LAG a fresh rollback pin) — a
pinned/canary/rolled-back revision's assets are NEVER reaped. FAIL-SAFE: if
any live revision has no resolvable build-id, if the CR pins a revision while
status.currentTraffic is empty (status wiped/lagging), or if the pin itself
cannot be resolved to a build-id, the GC is skipped entirely
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
  kn-next gc [--build-id <id>] [-n <namespace>] [--dry-run]

Options:
  --build-id <id>       Build-id to treat as the newest (e.g. the tag just
                        deployed). Omit to order by the remote listing alone.
  -n, --namespace <ns>  Kubernetes namespace of the NextApp (default: default)
  --dry-run             Print the FULL reap/keep plan (would-reap candidates,
                        window-kept, live-kept, unmarked-kept, reserved
                        shared dirs) and issue ZERO deletes. The cluster reads
                        and the plan are identical to a real run.
  -h, --help            Show this help
`;

/**
 * Renders the synchronous fd-1 outcome report for one {@link runAssetGC}
 * result — pure so the exact output contract (including the `--dry-run` full
 * plan and the machine-greppable skip-reason tokens) is unit-testable. A
 * command that may have DELETED objects must always print what it did;
 * gcMain writes this via writeSync (never the async pino transport).
 */
export function renderGcReport(
    appName: string,
    namespace: string,
    res: AssetGCResult,
): string {
    if (!res.pruned) {
        // The `[<token>]` suffix is a REQUIRED, byte-identical machine-readable
        // contract (v3-P4a): the common `gc: SKIPPED (fail-safe over-keep)
        // [<token>] — <human reason>` shape is assembled here so the token prefix
        // is pinned once, and the switch below is EXHAUSTIVE over GcSkipReason —
        // its `never` default makes a future skip cause fail to COMPILE unless it
        // is given a token AND a rendered human reason (stops P4b's future token
        // from silently mislabeling).
        const token: GcSkipReason =
            res.skipReason ?? "unresolvable-live-build-id";
        const prefix = `gc: SKIPPED (fail-safe over-keep) [${token}] — `;
        switch (token) {
            case "pinned-with-empty-status":
                return (
                    prefix +
                    `${appName} pins revision "${res.pinnedRevision}" ` +
                    `(spec.traffic.revisionName) but status.currentTraffic is empty ` +
                    `(status wiped or lagging); a window-only prune could reap the ` +
                    `pinned build. Nothing was deleted.\n`
                );
            case "pinned-not-resolvable":
                return (
                    prefix +
                    `${appName} pins revision "${res.pinnedRevision}" ` +
                    `(spec.traffic.revisionName) but the pin's build-id could not ` +
                    `be resolved (revision missing, build-id label absent, or the ` +
                    `read failed), so the pinned build cannot be proven protected. ` +
                    `Nothing was deleted.\n`
                );
            case "unresolvable-live-build-id":
                return (
                    prefix +
                    `a live revision of ${appName} has no resolvable build-id label; ` +
                    `nothing was deleted. ` +
                    `live revisions: [${res.liveRevisions.join(", ")}]\n`
                );
            case "traffic-drift-during-plan":
                return (
                    prefix +
                    `the pin or status.currentTraffic of ${appName} changed between ` +
                    `the GC plan and the first delete (or the re-read failed); the ` +
                    `delete set may no longer be safe, so the deletes were aborted. ` +
                    `Nothing was deleted.\n`
                );
            default: {
                // Exhaustiveness guard: if a new GcSkipReason is added without a
                // render case above, this assignment fails to type-check.
                const _exhaustive: never = token;
                return _exhaustive;
            }
        }
    }

    const s = res.summary;
    if (s?.dryRun) {
        // #264 part 2: the FULL reap/keep plan, every bucket named, and an
        // explicit statement that no delete was issued.
        return [
            `gc: DRY-RUN for ${appName} (ns ${namespace}) — plan only, nothing was deleted.`,
            `  would reap:                        [${s.reaped.join(", ")}]`,
            `  kept (retain window):              [${s.keptWindow.join(", ")}]`,
            `  kept (live traffic):               [${s.keptLive.join(", ")}]`,
            `  kept (unmarked, no ${BUILD_MARKER_FILENAME}):  [${s.keptUnmarked.join(", ")}]`,
            `  excluded (reserved shared dirs):   [${s.reservedExcluded.join(", ")}]`,
            `  live revisions protected:          [${res.liveRevisions.join(", ")}]`,
            "",
        ].join("\n");
    }

    // Unmarked prefixes were skipped LOUDLY, by name (#264 marker
    // inversion — pre-marker uploads / unknown dirs are over-kept).
    const keptUnmarked = s?.keptUnmarked ?? [];
    const unmarkedNote =
        keptUnmarked.length > 0
            ? `; unmarked prefixes kept (no ${BUILD_MARKER_FILENAME} marker — ` +
              `pre-marker upload or unknown dir): [${keptUnmarked.join(", ")}]`
            : "";
    return (
        `gc: completed for ${appName} (ns ${namespace}) — ` +
        `live revisions protected: [${res.liveRevisions.join(", ")}]` +
        `; reaped: [${(s?.reaped ?? []).join(", ")}]` +
        `${unmarkedNote}\n`
    );
}

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
        {
            app: config.name,
            namespace: args.namespace,
            buildId: args.buildId,
            dryRun: args.dryRun,
        },
        "Running asset retention GC (read-only against the cluster)...",
    );

    const res = runAssetGC(
        config,
        args.namespace,
        args.buildId,
        runCapture,
        pruneOldBuilds,
        args.dryRun,
    );

    // Synchronous outcome report on fd 1: pino's transport is async and a
    // process.exit right after can swallow it — a command that may have
    // DELETED objects must always print what it did (or, under --dry-run,
    // the full plan of what it WOULD do).
    writeSync(1, renderGcReport(config.name, args.namespace, res));
    return 0;
}

// NO self-entry block here, DELIBERATELY — this module is reached ONLY via
// the kn-next bin's subcommand dispatch (see the hazard note atop deploy.ts's
// dispatcher: an isEntrypoint block in a bin-dispatched module re-arms the
// tsup-inlining hijack, #263 — observed live with THIS module in PR #262,
// deploy.ts imports runAssetGC statically).
