/**
 * Result construction + human-table rendering for `knext doctor`.
 */

import type { CheckResult, CheckStatus } from "./types";

/**
 * Build a {@link CheckResult}. Extracted verbatim from the `push` closure the
 * pre-#1055 single-file `runDoctor` used: the hint key is included only when
 * truthy, so a result without a hint has no `hint` property at all (which the
 * table and JSON both rely on).
 */
export function mk(
    id: string,
    title: string,
    status: CheckStatus,
    detail: string,
    hint?: string,
): CheckResult {
    return { id, title, status, detail, ...(hint ? { hint } : {}) };
}

const STATUS_LABEL: Record<CheckStatus, string> = {
    pass: "PASS",
    warn: "WARN",
    fail: "FAIL",
    skip: "SKIP",
    error: "ERROR",
};

/** Render the human table (one status-tagged row per check, + repair hint). */
export function formatDoctorTable(checks: readonly CheckResult[]): string {
    const titleWidth = Math.max(...checks.map((c) => c.title.length), 5);
    const rows = checks.map(
        (c) =>
            `${STATUS_LABEL[c.status]}  ${c.title.padEnd(titleWidth)}  ${c.detail}${c.hint ? ` (hint: ${c.hint})` : ""}`,
    );
    return `${rows.join("\n")}\n`;
}
