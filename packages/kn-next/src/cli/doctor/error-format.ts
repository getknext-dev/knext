/**
 * Shared one-actionable-sentence formatting (#1535).
 *
 * The problem: several doctor checks (and `deploy`'s post-apply wait) speak to
 * a user who may have never touched Kubernetes before. Left alone, "actionable"
 * drifts into "here is the raw kubectl stderr, good luck" — a stack trace by
 * another name. This module is the ONE place that decides the shape: a short
 * plain sentence by default, with the raw diagnostic available on request
 * (`knext doctor --verbose`) rather than always inline.
 *
 * Every check keeps its own richer internal diagnosis (classification,
 * multi-app fan-out, etc.) — this only governs what the TOP of `detail` reads
 * like, and where the rest goes.
 */

/**
 * Build a check's `detail` string: `sentence` alone by default, or
 * `sentence` followed by the raw diagnostic when `verbose` is true.
 *
 * `sentence` MUST be a complete, actionable, stack-trace-free statement on its
 * own — this function never fabricates one.
 */
export function actionableDetail(
    sentence: string,
    verboseDiagnostic: string,
    verbose: boolean,
): string {
    if (!verbose || verboseDiagnostic.length === 0) {
        return sentence;
    }
    return `${sentence} [--verbose] ${verboseDiagnostic}`;
}
