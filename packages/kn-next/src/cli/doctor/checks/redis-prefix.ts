/**
 * Redis key prefixes of the cluster's NextApps: no two apps may share one.
 *
 * Apps on one Redis are separated by key prefix only. Two apps under one prefix
 * read each other's entries and share each other's tag invalidations, and the
 * outage collapse sweeps every key under `<prefix>:cache:*` / `<prefix>:uc:*`.
 * The operator gives every app without `spec.cache.keyPrefix` its own derived
 * prefix (`defaultRedisKeyPrefix`), so a collision takes an explicit choice:
 *
 *  - the same `keyPrefix` (or `spec.env.REDIS_KEY_PREFIX`) on two apps;
 *  - the shared fallback `kn-next`, or a prefix nested under it such as
 *    `kn-next:cache`, set on purpose (the runtime refuses to sweep under
 *    either, so that app's cache is never collapsed after an outage, and the
 *    operator never reaps it on delete);
 *  - one prefix nested in another's sweep pattern: `shop` sweeps `shop:cache:*`,
 *    which holds every key of an app prefixed `shop:cache`.
 *
 * Prefixes are compared whatever the apps' Redis URLs say: a URL can come from a
 * Secret (envMap), so doctor cannot prove two apps use different servers. WARN,
 * never FAIL, for the same reason. A `REDIS_KEY_PREFIX` sourced from an envMap
 * Secret cannot be read either; it is named as unverified.
 *
 * It also names any app whose stored `spec.cache.keyPrefix` the CRD's
 * admission rule now refuses (redis-key-prefix.ts), whatever its provider.
 *
 * Contributes NO row when no NextApp uses a Redis cache (and none stores a
 * refused keyPrefix), when the cluster is
 * unreachable, or when the list cannot be read (the app-image row reports that),
 * which keeps every other report's row set unchanged (doctor-golden.test.ts).
 * Read-only: the same `get nextapps` the app-image check issues.
 */

import { createHash } from "node:crypto";
import {
    keyPrefixProblem,
    LEGACY_SHARED_KEY_PREFIX,
} from "../../redis-key-prefix";
import { safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

/** The prefix every app without one falls back to at runtime. */
export { LEGACY_SHARED_KEY_PREFIX };

/**
 * The operator's default prefix for an app with no `spec.cache.keyPrefix`:
 * `kn-` + the first 12 hex of sha256("<namespace>/<name>"). Lockstep with
 * `defaultRedisKeyPrefix` in the operator (internal/controller/redis_key_prefix.go);
 * both pin the same vector.
 */
export function defaultRedisKeyPrefix(namespace: string, name: string): string {
    const hex = createHash("sha256")
        .update(`${namespace}/${name}`)
        .digest("hex");
    return `kn-${hex.slice(0, 12)}`;
}

interface NextAppItem {
    metadata?: { name?: string; namespace?: string };
    spec?: {
        cache?: { provider?: string; keyPrefix?: string };
        env?: Record<string, string>;
        secrets?: { envMap?: Record<string, unknown> };
    };
}

const TITLE = "Redis key prefixes";
const HINT =
    "give each app its own prefix: remove cache.keyPrefix to use the per-app default, or set a unique one of at most 63 characters with no whitespace or * ? [ ] \\, outside 'kn-next'; keys under the old prefix expire on their own";

export function redisPrefixCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) return [];
    const res = ctx.kubectl([
        "kubectl",
        "get",
        "nextapps",
        "--all-namespaces",
        "-o",
        "json",
    ]);
    if (!res.ok) return [];
    const items = safeJson<{ items?: NextAppItem[] }>(res.stdout)?.items ?? [];

    const byPrefix = new Map<string, string[]>();
    const unverified: string[] = [];
    // A stored keyPrefix the CRD's admission rule now refuses. Ratcheting keeps
    // the app updatable on Kubernetes >= 1.30 while the prefix is unchanged;
    // below that floor its next spec change is refused. Checked whatever the
    // cache provider: admission validates the field regardless.
    const invalid: string[] = [];
    let redisApps = 0;
    for (const item of items) {
        const name = item.metadata?.name;
        const namespace = item.metadata?.namespace;
        const stored = item.spec?.cache?.keyPrefix;
        if (name && namespace && typeof stored === "string") {
            const problem = keyPrefixProblem(stored);
            if (problem)
                invalid.push(
                    `${namespace}/${name}: keyPrefix '${stored}' ${problem}, so the cluster now refuses it (change it before the app's next update)`,
                );
        }
        if (!name || !namespace || item.spec?.cache?.provider !== "redis")
            continue;
        redisApps += 1;
        const app = `${namespace}/${name}`;
        const explicit = item.spec.cache.keyPrefix;
        const fromEnv = item.spec.env?.REDIS_KEY_PREFIX;
        let prefix: string;
        // An empty value is unset on both, as the operator treats it: an empty
        // spec.env REDIS_KEY_PREFIX gets the derived default rendered in its
        // place (userSetsRedisKeyPrefix in the operator), so it must fall
        // through to that default here rather than count as a prefix of "".
        if (explicit) prefix = explicit;
        else if (fromEnv) prefix = fromEnv;
        else if (item.spec.secrets?.envMap?.REDIS_KEY_PREFIX !== undefined) {
            unverified.push(app);
            continue;
        } else prefix = defaultRedisKeyPrefix(namespace, name);
        byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), app]);
    }
    if (redisApps === 0 && invalid.length === 0) return [];

    const problems: string[] = [...invalid];
    for (const [prefix, apps] of byPrefix) {
        if (apps.length > 1) {
            problems.push(
                `${apps.join(", ")} share the prefix '${prefix}' (each one's cache sweep and invalidations reach the others)`,
            );
        }
        if (prefix === LEGACY_SHARED_KEY_PREFIX) {
            problems.push(
                `${apps.join(", ")} use${apps.length > 1 ? "" : "s"} the shared fallback '${LEGACY_SHARED_KEY_PREFIX}' (its cache is never swept after an outage)`,
            );
        } else if (prefix.startsWith(`${LEGACY_SHARED_KEY_PREFIX}:`)) {
            problems.push(
                `${apps.join(", ")} use${apps.length > 1 ? "" : "s"} '${prefix}', inside the shared fallback '${LEGACY_SHARED_KEY_PREFIX}' (its cache is never swept after an outage)`,
            );
        }
    }
    const prefixes = [...byPrefix.keys()];
    for (const outer of prefixes) {
        for (const inner of prefixes) {
            if (inner !== outer && inner.startsWith(`${outer}:`)) {
                problems.push(
                    `'${inner}' (${(byPrefix.get(inner) ?? []).join(", ")}) is inside the keyspace of '${outer}' (${(byPrefix.get(outer) ?? []).join(", ")}), whose cache sweep can reach it`,
                );
            }
        }
    }
    const unverifiedNote =
        unverified.length > 0
            ? ` Not verified (REDIS_KEY_PREFIX comes from a Secret): ${unverified.join(", ")}.`
            : "";
    if (problems.length > 0) {
        return [
            mk(
                "redis-prefix",
                TITLE,
                "warn",
                `${problems.join("; ")}.${unverifiedNote}`,
                HINT,
            ),
        ];
    }
    return [
        mk(
            "redis-prefix",
            TITLE,
            "pass",
            `${redisApps} app${redisApps === 1 ? "" : "s"} on Redis, each under its own key prefix.${unverifiedNote}`,
        ),
    ];
}
