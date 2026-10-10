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
 * status condition whose `observedGeneration` is at least the CR's OWN
 * `metadata.generation` — the same signal `knext status` renders
 * (`status.conditions`) and the cheapest one that is unambiguously the
 * OPERATOR's own writing, AT the generation `deploy` just applied.
 * `status.url` cannot be the signal: it stays empty for a healthy app that
 * has no ingress yet, so an empty url alone would false-warn a working
 * deploy.
 *
 * #1535 round 2: `conditions.length > 0` alone is NOT enough. On a REDEPLOY
 * (the common case, not the first deploy) the CR already carries conditions
 * from the PREVIOUS generation the last-good reconcile wrote — those are
 * still non-empty even against a dead or CrashLooping operator, so the very
 * first poll would read "reconciled" off stale data. The operator stamps
 * `ObservedGeneration: app.Generation` on every condition it sets
 * (`status_verdict.go`), which is exactly the field this module now checks
 * against the CR's own `metadata.generation` from the same `-o json` read.
 */

import { OPERATOR_NAMESPACE } from "./doctor/types";

export interface ReconcileWaitResult {
    reconciled: boolean;
    url: string;
    /**
     * Set when the operator observed THIS generation and holds the change:
     * `Ready=False`, reason `EffectiveSpecInvalid`. The previous Knative
     * Service keeps serving, so "reconciled" would be a false success.
     * `message` is the operator's own Ready message (it names the field).
     */
    held?: { message: string; kind: "platform" | "spec" };
}

/** The Ready reason the operator writes when it holds an app change. */
export const HELD_REASON = "EffectiveSpecInvalid";

/**
 * The reason the operator writes when the app's OWN spec is invalid
 * (including a footprint over the built-in budget). The change is not
 * applied either; the previous version keeps serving. The Ready message is
 * generic ("Spec does not meet validation requirements"); the specific,
 * field-naming message is on the Degraded condition with the same reason.
 */
export const INVALID_SPEC_REASON = "InvalidSpec";

/** The actionable failure for an app whose own spec the operator rejected. */
export function invalidSpecMessage(operatorMessage: string): string {
    return `The operator rejected this spec; the previous version is still serving. ${operatorMessage} Fix the spec in knext.config.ts and deploy again.`;
}

/**
 * The actionable failure for a held app change: the operator's own message
 * (which names the blamed field) plus the remedy. Exact text is
 * mutation-proved (`deploy-reconcile-wait.test.ts`).
 */
export function heldChangeMessage(operatorMessage: string): string {
    return `The operator is holding this change; the previous version is still serving. ${operatorMessage} Raise the platform budget (KnextPlatform), or lower maxScale / poolMax in knext.config.ts, then deploy again.`;
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

interface ParsedNextApp {
    generation?: number;
    conditions?: unknown[];
    url?: string;
}

function parseNextApp(raw: string): ParsedNextApp | undefined {
    try {
        const parsed = JSON.parse(raw) as {
            metadata?: { generation?: unknown };
            status?: { conditions?: unknown[]; url?: string };
        };
        const generation = parsed.metadata?.generation;
        return {
            generation: typeof generation === "number" ? generation : undefined,
            conditions: parsed.status?.conditions,
            url: parsed.status?.url,
        };
    } catch {
        return undefined;
    }
}

/**
 * A condition is evidence of reconciliation only when the operator wrote it
 * AT OR AFTER the generation this poll is watching for — see the module
 * doc comment (#1535 round 2). `generation` missing (a malformed/partial
 * read) is treated as "cannot tell", i.e. not reconciled, rather than
 * guessing.
 */
function isReconciled(
    generation: number | undefined,
    conditions: unknown[] | undefined,
): boolean {
    if (typeof generation !== "number" || !Array.isArray(conditions)) {
        return false;
    }
    return conditions.some((c) => {
        if (typeof c !== "object" || c === null) return false;
        const observed = (c as { observedGeneration?: unknown })
            .observedGeneration;
        return typeof observed === "number" && observed >= generation;
    });
}

/** Prefer the Degraded/InvalidSpec message (names the field) over Ready's. */
function invalidSpecDetail(
    conditions: unknown[],
    generation: number,
    readyMessage: unknown,
): string {
    for (const c of conditions) {
        if (typeof c !== "object" || c === null) continue;
        const d = c as Record<string, unknown>;
        if (
            d.type === "Degraded" &&
            d.status === "True" &&
            d.reason === INVALID_SPEC_REASON &&
            typeof d.observedGeneration === "number" &&
            d.observedGeneration >= generation &&
            typeof d.message === "string"
        ) {
            return d.message;
        }
    }
    return typeof readyMessage === "string" ? readyMessage : "";
}

/**
 * The operator's Ready message when it holds this generation's change, else
 * undefined. Only a Ready condition observed AT OR AFTER `generation` counts,
 * so a stale hold from an earlier generation never fails a fixed redeploy.
 */
function heldMessage(
    generation: number | undefined,
    conditions: unknown[] | undefined,
): { message: string; kind: "platform" | "spec" } | undefined {
    if (typeof generation !== "number" || !Array.isArray(conditions)) {
        return undefined;
    }
    const atGen = (o: unknown) => typeof o === "number" && o >= generation;
    for (const c of conditions) {
        if (typeof c !== "object" || c === null) continue;
        const cond = c as {
            type?: unknown;
            status?: unknown;
            reason?: unknown;
            message?: unknown;
            observedGeneration?: unknown;
        };
        if (
            cond.type === "Ready" &&
            cond.status === "False" &&
            cond.reason === HELD_REASON &&
            atGen(cond.observedGeneration)
        ) {
            return {
                message: typeof cond.message === "string" ? cond.message : "",
                kind: "platform",
            };
        }
        if (
            cond.type === "Ready" &&
            cond.status === "False" &&
            cond.reason === INVALID_SPEC_REASON &&
            atGen(cond.observedGeneration)
        ) {
            return {
                message: invalidSpecDetail(
                    conditions,
                    generation,
                    cond.message,
                ),
                kind: "spec",
            };
        }
    }
    return undefined;
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
        const parsed = result.ok ? parseNextApp(result.stdout) : undefined;
        if (typeof parsed?.url === "string") {
            lastUrl = parsed.url;
        }
        const held = heldMessage(parsed?.generation, parsed?.conditions);
        if (held !== undefined) {
            return { reconciled: true, url: lastUrl, held };
        }
        if (isReconciled(parsed?.generation, parsed?.conditions)) {
            return { reconciled: true, url: lastUrl };
        }
        if (now() >= deadline) {
            return { reconciled: false, url: lastUrl };
        }
        await sleep(pollIntervalMs);
    }
}
