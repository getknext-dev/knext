/**
 * #1535 — after `knext deploy` applies the NextApp CR, wait briefly for the
 * operator to begin reconciling it, and say so plainly when it doesn't.
 *
 * Before this module, `deploy()` did a single, immediate
 * `kubectl get nextapp -o jsonpath={.status.url}` right after the apply and
 * logged whatever came back — including an empty string when the operator
 * hadn't reconciled yet (not running at all, CrashLoopBackOff, wrong
 * namespace watch, ...). A zero-Kubernetes user reads that as "it worked,
 * with no URL", not as the operator being down.
 *
 * READ-ONLY (ADR-0001): the only cluster call is a polled `kubectl get
 * nextapp -o json`. "Reconciled" = the operator has written at least one
 * status condition — the same signal `knext status` renders
 * (`status.conditions`) and the cheapest one that is unambiguously the
 * OPERATOR's own writing. `status.url` cannot be the signal: it stays empty
 * for a healthy app that has no ingress yet, so an empty url alone would
 * false-warn a working deploy.
 */

import { OPERATOR_NAMESPACE } from "./doctor/types";

export interface ReconcileWaitResult {
    reconciled: boolean;
    url: string;
}

export interface KubectlGetResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/** Injectable `kubectl get nextapp ... -o json` boundary. MUST NOT throw. */
export type GetNextAppFn = () => KubectlGetResult;

/** Default total wait before giving up and reporting "not reconciled". */
export const RECONCILE_WAIT_MS_DEFAULT = 15_000;
const POLL_INTERVAL_MS_DEFAULT = 1_000;

/** The command doctor/deploy both point the user at when nothing reconciled. */
export function operatorPodCheckCommand(): string {
    return `kubectl get pods -n ${OPERATOR_NAMESPACE}`;
}

/**
 * #1535: the ONE actionable sentence for "CR applied but nothing reconciled
 * it in time" — exact string, mutation-proved
 * (`deploy-reconcile-wait.test.ts`).
 */
export function noReconcileMessage(waitMs: number): string {
    const seconds = Math.round(waitMs / 1000);
    return `NextApp applied; no operator reconciled it in ${seconds}s. Check the operator pod: ${operatorPodCheckCommand()}.`;
}

function parseStatus(
    raw: string,
): { conditions?: unknown[]; url?: string } | undefined {
    try {
        const parsed = JSON.parse(raw) as { status?: unknown };
        return parsed.status as { conditions?: unknown[]; url?: string };
    } catch {
        return undefined;
    }
}

/**
 * Poll `getNextApp` until the operator has written at least one status
 * condition, or `waitMs` elapses. Never throws — a kubectl failure mid-poll
 * (a transient apiserver blip) is treated the same as "not reconciled yet"
 * and the poll keeps going until the deadline.
 */
export async function waitForOperatorReconcile(
    getNextApp: GetNextAppFn,
    opts: {
        waitMs?: number;
        pollIntervalMs?: number;
        sleep?: (ms: number) => Promise<void>;
        /**
         * Clock source for the deadline check. MUST stay consistent with
         * `sleep` — a fake `sleep` paired with the real `Date.now` busy-spins
         * for the REAL wait duration (caught by this module's own test suite,
         * which timed out at 15s before this parameter existed). Defaults to
         * `Date.now`.
         */
        now?: () => number;
    } = {},
): Promise<ReconcileWaitResult> {
    const waitMs = opts.waitMs ?? RECONCILE_WAIT_MS_DEFAULT;
    const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS_DEFAULT;
    const now = opts.now ?? Date.now;
    const sleep =
        opts.sleep ??
        ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + waitMs;
    let lastUrl = "";
    for (;;) {
        const result = getNextApp();
        const status = result.ok ? parseStatus(result.stdout) : undefined;
        if (typeof status?.url === "string") {
            lastUrl = status.url;
        }
        const conditions = status?.conditions;
        if (Array.isArray(conditions) && conditions.length > 0) {
            return { reconciled: true, url: lastUrl };
        }
        if (now() >= deadline) {
            return { reconciled: false, url: lastUrl };
        }
        await sleep(pollIntervalMs);
    }
}
