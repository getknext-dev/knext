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
 *
 * ## Why the clients module is imported LAZILY (#441)
 *
 * `@knext/lib/clients` statically pulls `@cerbos/grpc`, `minio` and `pg` — by far
 * the heaviest graph the supervisor touches, and it is needed ONLY at shutdown to
 * close two pools. A static import here would evaluate that whole graph in the
 * supervisor BEFORE it spawns the Next.js child (static ESM imports run before the
 * importing module's body), so its cost lands on the child's cold start — the
 * ~1 CPU-second measured in #441.
 *
 * The drain HOOK is still registered eagerly, before the spawn: a SIGTERM arriving
 * mid-boot must drain correctly. Only the module LOAD moves to drain time, where
 * it is off the critical path and bounded by the shutdown grace cap. If the pools
 * were never opened the closes are no-ops, and a load failure is swallowed —
 * draining must never throw.
 */
import { createLogger } from "../utils/logger";
import { registerShutdownDrain } from "./shutdown";

const log = createLogger({ module: "server" });

/** The slice of `@knext/lib/clients` the drain needs. */
export interface DbPoolClosers {
    closeDbPool(): Promise<void>;
    closeDbPoolRO(): Promise<void>;
}

/** Loads the pool closers. Injected in tests; real one is a dynamic import. */
export type DbClientsLoader = () => Promise<DbPoolClosers>;

const loadDbClients: DbClientsLoader = () => import("@knext/lib/clients");

export interface DrainDbPoolsOptions {
    /** Injected for tests; defaults to the lazy `@knext/lib/clients` import. */
    readonly loadClients?: DbClientsLoader;
}

/**
 * Close BOTH Postgres pools (writer + RO). Best-effort and non-fatal: each close
 * runs independently so a failure of one never skips the other, and a rejection
 * is logged (warn) rather than propagated — draining must not throw. Always
 * resolves; the shutdown grace cap is the backstop for a hung close (including a
 * hung module load).
 */
export async function drainDbPools(
    options: DrainDbPoolsOptions = {},
): Promise<void> {
    let clients: DbPoolClosers;
    try {
        clients = await (options.loadClients ?? loadDbClients)();
    } catch (err) {
        log.warn(
            { err },
            "DB clients module failed to load during shutdown; skipping pool drain (non-fatal)",
        );
        return;
    }

    await Promise.all([
        clients.closeDbPool().catch((err) => {
            log.warn(
                { err },
                "DB writer pool drain failed during shutdown (non-fatal)",
            );
        }),
        clients.closeDbPoolRO().catch((err) => {
            log.warn(
                { err },
                "DB RO pool drain failed during shutdown (non-fatal)",
            );
        }),
    ]);
}

/**
 * Register {@link drainDbPools} to run on SIGTERM after the HTTP drain.
 *
 * Called EAGERLY by node-server.ts, before the child is spawned — this is the
 * shutdown-safety path and is deliberately never deferred (#441).
 */
export function registerDbPoolDrain(options: DrainDbPoolsOptions = {}): void {
    registerShutdownDrain(() => drainDbPools(options));
}
