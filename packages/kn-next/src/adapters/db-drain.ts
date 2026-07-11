/**
 * DB-pool drain for the Knative runtime's graceful shutdown (PGS-1, #237/#246).
 *
 * On SIGTERM — after HTTP has drained — the runtime closes its Postgres pools so
 * in-flight transactions commit-or-rollback (instead of being severed mid-write
 * on scale-down) and a scaling-down replica releases its gateway connections
 * cleanly (no leaked sockets holding a scale-to-zero compute awake).
 *
 * Two pools exist (ADR-0019 + #245): the WRITER pool over `DATABASE_URL`
 * (`closeDbPool`) and the read-only pool over `DATABASE_URL_RO`
 * (`closeDbPoolRO`). Both must be drained. Each close is:
 *  - idempotent + a no-op when its pool was never opened (`getDbRO` never called,
 *    or `DATABASE_URL_RO` unset → the app fell back to the writer) — see
 *    @knext/lib/clients — so draining never errors in the no-RO-pool case;
 *  - handled INDEPENDENTLY so one pool's failure can't skip the other's close;
 *  - bounded by `gracefulShutdown`'s grace cap (SHUTDOWN_GRACE_MS), so a slow or
 *    unreachable close can never wedge shutdown past terminationGracePeriodSeconds.
 *
 * Extracted from node-server.ts as a pure function so the wiring is unit-testable
 * without spawning the real runtime (mirrors env.ts / buildChildEnv). Kept in the
 * runtime package so @knext/lib's pool stays free of any dependency on the runtime
 * or ./shutdown — no circular dependency.
 */
import { closeDbPool, closeDbPoolRO } from "@knext/lib/clients";
import { createLogger } from "../utils/logger";
import { registerShutdownDrain } from "./shutdown";

const log = createLogger({ module: "server" });

/**
 * Close BOTH Postgres pools (writer + RO). Best-effort and non-fatal: each close
 * runs independently so a failure of one never skips the other, and a rejection
 * is logged (warn) rather than propagated — draining must not throw. Always
 * resolves; the shutdown grace cap is the backstop for a hung close.
 */
export async function drainDbPools(): Promise<void> {
    await Promise.all([
        closeDbPool().catch((err) => {
            log.warn(
                { err },
                "DB writer pool drain failed during shutdown (non-fatal)",
            );
        }),
        closeDbPoolRO().catch((err) => {
            log.warn(
                { err },
                "DB RO pool drain failed during shutdown (non-fatal)",
            );
        }),
    ]);
}

/** Register {@link drainDbPools} to run on SIGTERM after the HTTP drain. */
export function registerDbPoolDrain(): void {
    registerShutdownDrain(drainDbPools);
}
