/**
 * Node.js version vs the floor. LOCAL and read-only (no cluster call), so it
 * runs even when the cluster is unreachable.
 *
 * The CLI's start-up guard already refuses a Node below the floor; this row
 * puts the same fact in the report (and in `--json`), and a failing version
 * carries the guard's own message so the two cannot drift.
 */

import { checkNodeFloor, NODE_FLOOR_MAJOR } from "../../node-floor";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

export function nodeFloorCheck(ctx: CheckContext): CheckResult[] {
    const version = ctx.deps.nodeVersion ?? process.versions.node;
    const verdict = checkNodeFloor(version);
    if (verdict.ok) {
        return [
            mk(
                "node-version",
                "Node.js version",
                "pass",
                `Node.js ${version} (floor: ${NODE_FLOOR_MAJOR})`,
            ),
        ];
    }
    return [
        mk(
            "node-version",
            "Node.js version",
            "fail",
            verdict.message,
            `upgrade Node.js to ${NODE_FLOOR_MAJOR} or later: https://nodejs.org`,
        ),
    ];
}
