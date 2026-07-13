/**
 * Build-id retention GC — skew protection (#93, ADR-0011).
 *
 * Version skew happens when a browser running build A requests
 * `_next/static/<A>/...` chunks after the server has rolled forward to build B.
 * knext serves those chunks from the durable object store, so as long as build
 * A's prefix survives, the old client keeps working. The risk is unbounded
 * storage growth if old build prefixes are NEVER reaped.
 *
 * This module decides — PURELY, with no I/O — which build-ids are safe to delete.
 * It is the SOLE build-id-pruning authority. Deletes are scoped to
 * `<app>/_next/static/<buildId>/`; the bare `<app>/` deletion remains
 * TEARDOWN-ONLY (operator finalizer, ADR-0008) and must NEVER be used as a
 * deploy-time prune.
 *
 * Two keep rules, OR'd together (retain-window OR live ⇒ keep):
 *   1. Retain window — keep the newest `retain` build-ids (the skew window).
 *   2. Live set — keep any build-id observed serving traffic
 *      (`NextApp.Status.CurrentTraffic`, #92). This protects a pinned / canary /
 *      rolled-back revision even when it is OLDER than the retain window, so the
 *      GC never reaps the build a #92 rollback is actively serving.
 *
 * The only/last build is always kept, and an empty build-id is never proposed
 * for deletion (it would scope to the bare `<app>/` prefix — forbidden).
 */

/** Default number of recent build-ids to retain (the skew window). */
export const DEFAULT_RETAIN = 3;

export interface SelectBuildsInput {
    /** Build-ids currently present in the object store, under `<app>/_next/static/`. */
    readonly remoteBuildIds: readonly string[];
    /**
     * Map of build-id → a monotonic ordering key (e.g. upload time, ms epoch).
     * Larger = newer. Build-ids missing a timestamp sort oldest (treated as 0).
     */
    readonly timestamps: Readonly<Record<string, number>>;
    /**
     * The RESOLVED build-ids of the revisions currently serving traffic. The
     * caller (deploy.ts) reads `NextApp.Status.CurrentTraffic[].revisionName`
     * and resolves each revision to its build-id via the
     * `apps.kn-next.dev/build-id` label the operator stamps onto the revision
     * (READ-ONLY, ADR-0001). Matched by EXACT equality below — never reaped
     * regardless of the retain window.
     *
     * Defect B (over-DELETE) fix: matching must be exact. A substring match
     * could (a) fail to protect a live build whose id is not a substring of any
     * token, or (b) coincidentally "protect" the wrong build. Exact equality on
     * resolved build-ids is the only correct, fail-safe contract.
     */
    readonly liveBuildIds: readonly string[];
    /** How many newest build-ids to retain. Clamped to >= 1. */
    readonly retain: number;
}

/** True iff `buildId` EXACTLY equals a resolved live build-id (defect B fix). */
function isLive(buildId: string, liveBuildIds: readonly string[]): boolean {
    return liveBuildIds.includes(buildId);
}

/**
 * The full reap/keep partition of the candidate set (#264 part 2 — the
 * `kn-next gc --dry-run` plan). Every candidate lands in EXACTLY one bucket;
 * `selectBuildsToDelete` delegates here, so the printed plan and the actual
 * reap set share one implementation and cannot drift.
 */
export interface BuildClassification {
    /** Safe to delete, oldest-first (identical to `selectBuildsToDelete`). */
    reap: string[];
    /** Kept by the retain window (the newest `max(retain, 1)`), newest-first. */
    keptWindow: string[];
    /**
     * Kept ONLY by the live-set rule (outside the window but exactly equal to
     * a resolved live build-id), newest-first. A live id inside the window is
     * counted as window-kept, never double-counted here.
     */
    keptLive: string[];
}

/**
 * Partitions the candidate build-ids into reap / window-kept / live-kept.
 * Pure: no I/O. Guarantees (shared with {@link selectBuildsToDelete}):
 *   - keeps the newest `max(retain, 1)` build-ids,
 *   - keeps any build-id EXACTLY in {@link SelectBuildsInput.liveBuildIds},
 *   - never reaps the only/last build (it is window-kept),
 *   - drops empty/falsy build-ids (never proposes an unscoped delete),
 *   - de-dupes the input and orders the reap set deterministically
 *     (oldest-first).
 */
export function classifyBuilds(input: SelectBuildsInput): BuildClassification {
    const { remoteBuildIds, timestamps, liveBuildIds } = input;
    const retain = Math.max(1, input.retain | 0);

    // De-dupe and drop empties (an empty id would scope to the bare `<app>/`).
    const unique = Array.from(
        new Set(remoteBuildIds.filter((id) => typeof id === "string" && id)),
    );

    // Newest-first ordering by timestamp (missing → 0 → oldest). Stable on ties.
    const byNewest = [...unique].sort(
        (a, b) => (timestamps[b] ?? 0) - (timestamps[a] ?? 0),
    );

    // Defensive: never delete the only remaining build — it is window-kept
    // (retain is clamped to >= 1, so the window always covers it).
    const windowKept = new Set(byNewest.slice(0, retain));

    const out: BuildClassification = { reap: [], keptWindow: [], keptLive: [] };
    for (const id of byNewest) {
        if (windowKept.has(id)) out.keptWindow.push(id);
        else if (isLive(id, liveBuildIds)) out.keptLive.push(id);
        else out.reap.push(id);
    }

    // Reap oldest-first for deterministic, low-surprise deletion order.
    out.reap.reverse();
    return out;
}

/**
 * Returns the build-ids that are safe to delete, oldest-first. Pure: no I/O.
 * Thin façade over {@link classifyBuilds} (the single selection authority);
 * see it for the guarantees.
 */
export function selectBuildsToDelete(input: SelectBuildsInput): string[] {
    return classifyBuilds(input).reap;
}

/**
 * Parses the REVISION NAMES of the live traffic targets out of the operator's
 * status JSON, as read READ-ONLY via
 * `kubectl get nextapp <n> -o jsonpath={.status.currentTraffic}`
 * (ADR-0001: the CLI never mutates the cluster). Returns the `revisionName` of
 * every traffic target.
 *
 * Defect B fix: this returns revision NAMES, not build-ids — a revision name
 * does not contain the build-id (Knative auto-names `<app>-<NNNNN>`, the image
 * is digest-pinned). deploy.ts resolves each name to its build-id via the
 * `apps.kn-next.dev/build-id` label the operator stamps onto the revision.
 *
 * Nil-safe: returns `[]` on empty/malformed/non-array input. Combined with the
 * fail-safe resolution in deploy.ts (skip GC if any resolution fails/empty),
 * a failure can only ever make the GC MORE conservative — over-keep, never
 * over-delete.
 */
export function parseLiveRevisionNames(currentTrafficJson: string): string[] {
    const raw = currentTrafficJson?.trim();
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const entry of parsed) {
        if (
            entry &&
            typeof entry === "object" &&
            "revisionName" in entry &&
            typeof (entry as { revisionName?: unknown }).revisionName ===
                "string"
        ) {
            const name = (entry as { revisionName: string }).revisionName;
            if (name) out.push(name);
        }
    }
    return out;
}

/**
 * Reads the build-id of a single live revision. deploy.ts wires this to
 * `kubectl get revision <name> -n <ns> -o jsonpath={.metadata.labels.apps\.kn-next\.dev/build-id}`
 * (READ-ONLY, ADR-0001). Returns the build-id, or `""` when the label is absent
 * (revision predates the label) or the read failed and the caller swallowed it.
 */
export type RevisionBuildIdResolver = (revisionName: string) => string;

/** Result of {@link resolveLiveBuildIds}: a discriminated, fail-safe union. */
export type ResolveLiveResult =
    | { readonly ok: true; readonly buildIds: string[] }
    | { readonly ok: false };

/**
 * Resolves live revision NAMES to their build-ids via {@link RevisionBuildIdResolver},
 * FAIL-SAFE (defect B). If ANY live revision cannot be resolved to a non-empty
 * build-id — label missing, empty, or the resolver throws — returns `{ ok: false }`
 * so the caller SKIPS the GC entirely (over-keep, never over-delete). Only when
 * every live revision resolves to a non-empty build-id does it return
 * `{ ok: true, buildIds }`. An empty input is `{ ok: true, buildIds: [] }`
 * (nothing live to protect → window-only GC).
 */
export function resolveLiveBuildIds(
    revisionNames: readonly string[],
    resolve: RevisionBuildIdResolver,
): ResolveLiveResult {
    const buildIds: string[] = [];
    for (const name of revisionNames) {
        let id: string;
        try {
            id = resolve(name);
        } catch {
            // Read failed → we cannot prove this live build is safe → skip GC.
            return { ok: false };
        }
        if (!id) {
            // No build-id label → unresolvable live build → skip GC (fail-safe).
            return { ok: false };
        }
        buildIds.push(id);
    }
    return { ok: true, buildIds };
}
