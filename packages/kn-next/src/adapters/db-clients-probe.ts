/**
 * Startup capability probe for `@getknext/lib/clients` (ADR-0055 / #1178).
 *
 * ## Why this exists
 *
 * The standalone runtime image (`templates/runtime-standalone`, ADR-0055)
 * DELIBERATELY does not ship `@getknext/lib/clients`' native closure
 * (`@cerbos/grpc` + `minio` + `pg` — by far the heaviest graph the supervisor
 * can reach, and the biggest CVE surface). The whole point of that image is a
 * lean supervisor.
 *
 * Both supervisor call sites FAIL OPEN when the module is absent, by design:
 *  - `db-drain.ts`'s `drainDbPools` catches the load failure, warns and returns
 *    ("draining must not throw");
 *  - `image-cache-sync.ts`'s `startImageCacheSync` only imports the store client
 *    when `STORAGE_BUCKET` is set.
 *
 * That keeps the ENTRYPOINT from crash-looping — but it makes the degradation
 * SILENT: on such an image the DB-pool RO-drain and image-cache sync are no-ops,
 * and un-drained DB sockets can hold a scale-to-zero compute awake (the #245
 * loss), with no signal until someone reads a socket count on a pod that will
 * not scale down. This probe converts that silence into ONE loud startup
 * WARNING that names the disabled capabilities and the scale-to-zero
 * consequence.
 *
 * ## Why RESOLVE, not import
 *
 * The heavy `@cerbos/grpc + minio + pg` graph must NOT be evaluated at boot —
 * that ~1 CPU-second is exactly the #441 cost the drain avoids by loading it
 * lazily at shutdown. `import.meta.resolve` answers "is this specifier
 * resolvable from here?" WITHOUT executing the module, so the probe is cheap and
 * keeps the cold-start guarantee. It resolves the SAME bare specifier both call
 * sites import, from THIS module's location — inside `@getknext/core`, whose
 * `node_modules` chain is the supervisor's `/app/node_modules`, exactly where the
 * closure would (or would not) be.
 */

import { createLogger } from "../utils/logger";

const log = createLogger({ module: "server" });

/** The exact specifier `db-drain.ts` and `image-cache-sync.ts` dynamically import. */
export const DB_CLIENTS_SPECIFIER = "@getknext/lib/clients";

/** Minimal logger surface (pino's `warn(obj, msg)`), injectable for tests. */
export interface ProbeLogger {
    warn(obj: unknown, msg?: string): void;
}

/**
 * Resolve a bare specifier to a URL WITHOUT importing it. Defaults to
 * `import.meta.resolve` (sync on Node ≥ 20 and Bun); injectable in tests.
 */
export type SpecifierResolver = (specifier: string) => string;

const defaultResolver: SpecifierResolver = (specifier) =>
    import.meta.resolve(specifier);

export interface DbClientsProbeOptions {
    /** Injected for tests; defaults to `import.meta.resolve`. */
    readonly resolve?: SpecifierResolver;
    /** Injected for tests; defaults to the runtime logger. */
    readonly log?: ProbeLogger;
}

/**
 * Probe whether `@getknext/lib/clients` is present in this runtime image and, if
 * NOT, emit exactly one loud WARNING naming the disabled capabilities and the
 * scale-to-zero consequence. Returns `true` iff the module resolves. Never
 * throws — a probe must not wedge boot.
 *
 * Call ONCE from the supervisor entry, AFTER the child is spawned — it is a
 * diagnostic, not shutdown-safety work, so it must run post-spawn (calling it
 * before the spawn drops pino's lazy first-emit onto the cold-start critical
 * path, #441). A source-order guard in standalone-image-contract.test.ts pins this.
 */
export function warnIfDbClientsUnavailable(
    options: DbClientsProbeOptions = {},
): boolean {
    const l = options.log ?? log;
    const resolveFn = options.resolve ?? defaultResolver;

    let err: unknown;
    try {
        resolveFn(DB_CLIENTS_SPECIFIER);
        return true;
    } catch (caught) {
        err = caught;
    }

    l.warn(
        { err, specifier: DB_CLIENTS_SPECIFIER },
        "@getknext/lib/clients is not present in this runtime image: DB-pool drain " +
            "(writer + read-only) and optimized-image-cache sync are DISABLED. On " +
            "scale-to-zero, un-drained database sockets can hold this compute awake " +
            "(the pod never scales to zero); optimized image variants stay pod-local " +
            "and are re-computed on every cold start. If this app uses knext's DB " +
            "pools or object-store image caching, rebuild the runtime image with the " +
            "clients closure included.",
    );
    return false;
}
