/**
 * otel-config.ts — pure OTel tracing gating + option resolution (#30).
 *
 * Tracing is DEFAULT-OFF. The runtime instrumentation hook
 * (`apps/file-manager/src/instrumentation.ts`) calls `resolveOtelOptions(env)`:
 *   - returns `null`  → do NOT initialize OTel (zero overhead, no exporter,
 *                       no span processors). This is the default.
 *   - returns options → pass to `@vercel/otel`'s `registerOTel(...)`.
 *
 * The operator sets `OTEL_TRACING_ENABLED=true` only when
 * `spec.observability.tracing.enabled` is set on the NextApp CR (ADR-0012),
 * so unconfigured apps pay nothing. No SaaS exporter defaults — the endpoint
 * points at a cluster-local, self-hostable OTLP collector (CLAUDE.md §8: no
 * lock-in).
 *
 * This module is intentionally dependency-free so it can be unit-tested under
 * vitest/Node without importing `@vercel/otel` or any OTel SDK.
 */

/** Minimal env shape — `process.env` satisfies it. */
export type OtelEnv = Record<string, string | undefined>;

/** Resolved OTel options the instrumentation hook maps onto registerOTel. */
export interface OtelOptions {
    /** Service name reported on every span's resource. */
    serviceName: string;
    /** OTLP/gRPC collector endpoint (self-hostable; never a SaaS default). */
    endpoint: string;
    /** Head-based trace sampling fraction, 0..1. Defaults to 1 (all). */
    sampleRate: number;
    /** Extra resource attributes (Knative revision/service/config, host). */
    resourceAttributes: Record<string, string>;
}

const DEFAULT_SERVICE_NAME = "file-manager";
const DEFAULT_ENDPOINT = "http://otel-collector.monitoring:4317";

/**
 * resolveOtelOptions gates and resolves OTel tracing from the environment.
 *
 * @param env - environment map (use `process.env` at the call site)
 * @returns   - `null` when tracing is disabled (default), else resolved options
 */
export function resolveOtelOptions(env: OtelEnv): OtelOptions | null {
    // DEFAULT-OFF gate: only the exact string "true" enables tracing.
    if (env.OTEL_TRACING_ENABLED !== "true") {
        return null;
    }

    const serviceName =
        env.OTEL_SERVICE_NAME || env.KN_APP_NAME || DEFAULT_SERVICE_NAME;

    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_ENDPOINT;

    // Head-based sampling fraction. Falls back to 1 (sample all) when unset or
    // unparseable so a bad value never silently drops all traces.
    const parsed = Number.parseFloat(env.OTEL_TRACES_SAMPLER_ARG ?? "");
    const sampleRate = Number.isFinite(parsed) ? parsed : 1;

    // Knative injects K_REVISION / K_SERVICE / K_CONFIGURATION; HOSTNAME is the
    // pod name. Only emit keys whose env is actually present.
    const resourceAttributes: Record<string, string> = {};
    if (env.K_REVISION) resourceAttributes["knative.revision"] = env.K_REVISION;
    if (env.K_SERVICE) resourceAttributes["knative.service"] = env.K_SERVICE;
    if (env.K_CONFIGURATION) {
        resourceAttributes["knative.configuration"] = env.K_CONFIGURATION;
    }
    // The knext runtime sanitizes the child's HOSTNAME (bind-address hazard,
    // #178) and preserves the pod identity as KNEXT_POD_NAME — prefer it, so
    // host.name is the real pod name rather than "" or a bind address.
    const hostName = env.KNEXT_POD_NAME || env.HOSTNAME;
    if (hostName) resourceAttributes["host.name"] = hostName;

    return { serviceName, endpoint, sampleRate, resourceAttributes };
}
