/**
 * #1865 — the shared guard against silently moving a NextApp from
 * cluster-local back to public. Shared because `deploy.ts` and
 * `preview.ts` both render and `kubectl apply` the SAME NextApp CR kind,
 * through the SAME `kubectl apply` semantics (a field omitted from the new
 * manifest is REMOVED from the live object relative to the last-applied
 * config) — so both carry the identical fail-open hazard, and splitting the
 * guard per caller would be exactly the kind of duplicated safety logic that
 * drifts the second time one of them changes.
 *
 * `--private`/a config's `networking.visibility` are per-run or persistent
 * INTENTS about what THIS apply should render; this guard is the separate
 * check that a LATER apply — one that does not carry that intent forward —
 * does not silently undo a prior one. `knext.config.ts`'s `networking.
 * visibility` is the persistent source of truth; `deploy --private` is a
 * per-run override over it. A PREVIEW has no such override at all (see
 * `preview.ts`'s call site) — a preview's visibility is driven entirely by
 * whatever `networking.visibility` the PR branch's config carries at each
 * redeploy. Moving a privately-deployed preview back to public is a commit
 * that sets `visibility: "public"` EXPLICITLY (the caller passes that as
 * `explicitPublic`); an omitted block stays refused. Never a flag.
 *
 * Reads the LIVE NextApp (if any) and compares its CURRENT visibility
 * against what THIS apply is about to render:
 *  - no live NextApp yet (NotFound) → nothing to protect, proceed.
 *  - live is already cluster-local, and this apply would not keep it
 *    cluster-local, and the caller has not explicitly confirmed public →
 *    REFUSE, with the caller-supplied remediation text (deploy and preview
 *    each have a different fix available — see their own call sites).
 *  - anything else (live is public/absent, this apply also sets
 *    cluster-local, or the caller explicitly confirmed public) → proceed.
 *
 * FAILS CLOSED on any OTHER read error (RBAC, network, a malformed
 * response): an error here must never read as "safe to downgrade" just
 * because the live state could not be confirmed.
 *
 * KNOWN LIMITATION, NOT CLOSED (TOCTOU): the live read here and the real
 * `kubectl apply` that follows in the caller are two separate round-trips,
 * not one atomic operation. If the live NextApp's visibility changes between
 * this read and that apply — a second knext invocation racing this one, or
 * an out-of-band `kubectl` edit — this guard can still be bypassed by the
 * race; it narrows the window, it does not close it. Accepted as
 * non-blocking: closing it would need a server-side conditional apply
 * (optimistic-concurrency `resourceVersion` precondition) this code does not
 * use today, and ADR-0001's premise is that the operator — not concurrent
 * CLI writers — is the thing reconciling a given NextApp name. Recorded here
 * rather than silently assumed away.
 */

import { captureKubectl } from "./schema/kubectl-capture";
import { excerpt, UsageError, withKubeContext } from "./shared";

export interface VisibilityDowngradeGuardArgs {
    namespace: string;
    name: string;
    context?: string;
    /** Whether THIS apply's rendered CR sets spec.networking.visibility to cluster-local. */
    willBeClusterLocal: boolean;
    /** Whether the caller has an explicit, deliberate "yes, make it public" confirmation. */
    explicitPublic: boolean;
    /**
     * The exact remediation sentence(s) for the refusal message. Deploy and
     * preview have different fixes available (deploy has --public; a
     * preview has no such flag and must be fixed by editing
     * knext.config.ts) — the shared guard states the problem, the caller
     * states the fix.
     */
    remediation: string;
}

/** Injectable so `preview.ts` can stub it in tests without a real cluster. */
export type VisibilityDowngradeGuard = (
    args: VisibilityDowngradeGuardArgs,
) => Promise<void>;

export const assertVisibilityDowngradeIsExplicit: VisibilityDowngradeGuard =
    async ({
        namespace,
        name,
        context,
        willBeClusterLocal,
        explicitPublic,
        remediation,
    }) => {
        if (willBeClusterLocal || explicitPublic) return;

        const result = captureKubectl(
            withKubeContext(
                [
                    "kubectl",
                    "get",
                    "nextapp",
                    name,
                    "-n",
                    namespace,
                    "-o",
                    "json",
                ],
                context,
            ),
        );
        if (!result.ok) {
            const stderr = result.stderr.trim();
            if (/notfound|not found/i.test(stderr)) {
                return; // first deploy: no live object to protect
            }
            throw new Error(
                `Could not read the current NextApp "${name}" in namespace "${namespace}" ` +
                    "before applying, so knext cannot confirm whether this would change its " +
                    "network visibility. Failing closed rather than risking a silent public " +
                    `downgrade of a private app. (${excerpt(stderr) || "kubectl failed with no stderr"})\n` +
                    "Check your kubeconfig/context; `knext doctor` diagnoses cluster prereqs.",
            );
        }

        let live: { spec?: { networking?: { visibility?: string } } };
        try {
            live = JSON.parse(result.stdout);
        } catch {
            throw new Error(
                `Could not parse kubectl's response for NextApp "${name}" before applying — ` +
                    "failing closed rather than risking a silent public downgrade of a private app.",
            );
        }

        if (live.spec?.networking?.visibility === "cluster-local") {
            throw new UsageError(
                `"${name}" in namespace "${namespace}" is currently deployed cluster-local ` +
                    `(private), but this apply would make it PUBLIC. ${remediation}`,
            );
        }
    };
