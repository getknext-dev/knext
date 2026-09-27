/**
 * #1535 round 3 — the shared `kubectl get nextapp -o json` "reconciled"
 * fixture, for every suite that stubs `captureKubectl` to keep itself
 * hermetic against the post-apply reconcile-wait poll deploy.ts now runs.
 *
 * `waitForOperatorReconcile` (`deploy-reconcile-wait.ts`) treats a NextApp
 * as reconciled only when `status.conditions` carries an entry whose
 * `observedGeneration` is at or after the CR's own `metadata.generation` —
 * see that module's doc comment for why (round 2, #1535). A stub that omits
 * `metadata.generation` (the round-1 shape: bare
 * `{ status: { conditions: [{ type: "Ready", status: "True" }] } }`) now
 * reads as "not reconciled" and blocks the real 15s default wait, which is
 * what made eight deploy suites start timing out in round 2 — their fixture
 * doubles were never updated, and the three that were got the pair copied
 * inline instead of shared. Centralizing it here means the pair can never
 * drift out of sync across suites again; every one of the ten suites that
 * stub this boundary imports from here instead of inlining the literal.
 */

export interface ReconciledNextAppOptions {
    /** `metadata.generation` on the CR. Defaults to 1. */
    generation?: number;
    /**
     * `status.conditions[0].observedGeneration`. Defaults to `generation`
     * (i.e. "reconciled"). Pass a lower number to build a STALE fixture for
     * a suite that specifically wants the not-yet-reconciled case — most
     * suites should just take the default.
     */
    observedGeneration?: number;
    conditionType?: string;
    conditionStatus?: string;
}

/** The parsed `kubectl get nextapp -o json` body — reconciled by default. */
export function reconciledNextApp(opts: ReconciledNextAppOptions = {}): {
    metadata: { generation: number };
    status: {
        conditions: Array<{
            type: string;
            status: string;
            observedGeneration: number;
        }>;
    };
} {
    const generation = opts.generation ?? 1;
    const observedGeneration = opts.observedGeneration ?? generation;
    return {
        metadata: { generation },
        status: {
            conditions: [
                {
                    type: opts.conditionType ?? "Ready",
                    status: opts.conditionStatus ?? "True",
                    observedGeneration,
                },
            ],
        },
    };
}

/**
 * The full `captureKubectl` stub result for a reconciled NextApp — drop
 * straight into `mock.module("../cli/schema/kubectl-capture", ...)`.
 */
export function reconciledNextAppCapture(opts: ReconciledNextAppOptions = {}): {
    ok: true;
    stdout: string;
    stderr: string;
} {
    return {
        ok: true,
        stdout: JSON.stringify(reconciledNextApp(opts)),
        stderr: "",
    };
}
