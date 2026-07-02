import { hostname } from "node:os";

/**
 * Bind/loopback values that must never be stashed as the pod identity:
 * they are addresses, not names (#184). `127.` is prefix-matched — the whole
 * 127.0.0.0/8 block is loopback (e.g. DNS collision sentinels like
 * 127.0.53.53), and no valid pod name contains a dot anyway.
 */
const BIND_OR_LOOPBACK_HOSTNAMES = new Set([
    "0.0.0.0",
    "::",
    "::1",
    "localhost",
]);

function isBindOrLoopback(value: string): boolean {
    const v = value.toLowerCase();
    return BIND_OR_LOOPBACK_HOSTNAMES.has(v) || v.startsWith("127.");
}

/**
 * Builds the environment object for the spawned Next.js standalone server.
 *
 * All process.env vars (including NODE_COMPILE_CACHE) are inherited via spread.
 * The operator may inject NODE_COMPILE_CACHE pointing at a shared PVC for
 * cross-cold-start bytecode caching — we MUST NOT hardcode or override it here.
 * The Dockerfile CMD supplies a fallback when the env var is unset at runtime.
 *
 * HOSTNAME is the one exception — it is SANITIZED, not inherited (#178).
 * next@16.2.x standalone treats HOSTNAME as the bind address AND bakes it
 * verbatim into the router's initUrl (server/lib/router-utils/resolve-routes.js),
 * while the middleware-visible request URL is normalized by NextURL (loopback
 * IPs → 'localhost', server/web/next-url.js). Kubernetes/Docker set
 * HOSTNAME=<pod-name>/<container-id> by default, which (verified against the
 * middleware-rewrite fixture, PR #177 / #178):
 *   - <pod-name> (resolvable)  → binds ONLY the pod IP, so Knative's
 *     queue-proxy (127.0.0.1:USER_PORT) gets ECONNREFUSED — total outage;
 *   - 127.0.0.1 / ::1          → initUrl origin ≠ middleware origin, so
 *     same-origin middleware rewrites are misclassified as EXTERNAL and
 *     self-proxied (the #174 500s / proxy loops);
 *   - <unresolvable name>      → getaddrinfo ENOTFOUND, crash on boot.
 * Emptying HOSTNAME makes server.js fall through to the safe 0.0.0.0 bind
 * with a consistent origin on both sides. The original value is preserved as
 * KNEXT_POD_NAME so observability (otel host.name) keeps the pod identity.
 *
 * Exported separately so tests can assert forwarding without starting the server
 * or spawning a real child process.
 */
export function buildChildEnv(
    overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
    const parentHostname = process.env.HOSTNAME;
    // Stash the pod identity before sanitizing — but never stash a bind or
    // loopback address (the operator injects HOSTNAME=0.0.0.0; compose files
    // and local runs use loopbacks), and never clobber an explicitly-wired
    // KNEXT_POD_NAME. On the operator path the env HOSTNAME is always the
    // 0.0.0.0 override and the downward API is NOT available (Knative gates
    // valueFrom.fieldRef behind `kubernetes.podspec-fieldref`, Disabled by
    // default — the webhook rejects such a ksvc on stock Knative), so inside
    // Kubernetes we recover the pod identity from the kernel hostname:
    // kubelet sets the pod's OS hostname to the pod name, and the env-var
    // override does not touch it (#184).
    const podName =
        process.env.KNEXT_POD_NAME ||
        (parentHostname && !isBindOrLoopback(parentHostname)
            ? parentHostname
            : undefined) ||
        (process.env.KUBERNETES_SERVICE_HOST ? hostname() : undefined);
    return {
        ...process.env,
        // Explicitly emptied (not deleted): documents intent and survives
        // naive `{ ...env }` copies that would otherwise re-inherit the
        // container's HOSTNAME.
        HOSTNAME: "",
        ...(podName ? { KNEXT_POD_NAME: podName } : {}),
        PORT: process.env.PORT ?? "3000",
        ...overrides,
    };
}
