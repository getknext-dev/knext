/**
 * (h, #951) metrics-port collision with queue-proxy. Knative's queue-proxy
 * sidecar binds several ports in EVERY revision pod: 8012/8013/8022/8112 and
 * its own metrics port 9090 unconditionally, and :9091 (its user-metrics
 * server) whenever the serving-wide request-metrics protocol is prometheus.
 * knext's runtime used to default its own metrics listener to that same 9091,
 * so on a cluster with request-metrics active the app lost the port race and
 * crash-looped with EADDRINUSE (S3-V Finding C-2). The platform default is now
 * :9464; this check exists for the override path (spec.env.METRICS_PORT).
 *
 * WHICH CONFIG KEY GOVERNS :9091 DEPENDS ON THE SERVING VERSION: read BOTH the
 * legacy `metrics.request-metrics-backend-destination` and the modern
 * `request-metrics-protocol`; an explicit "none" on either wins; an explicit
 * "prometheus" on either means bound; anything else present means a
 * non-prometheus backend; NEITHER present is "cannot determine", never silently
 * "bound".
 */

import { infraFailure, safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import {
    QUEUE_PROXY_OWNED_PORTS,
    QUEUE_PROXY_USER_METRICS_PORT,
    SKIP_UNREACHABLE,
} from "../types";

export function metricsCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [
            mk(
                "metrics-port",
                "Metrics-port collision (queue-proxy :9091)",
                "skip",
                SKIP_UNREACHABLE,
            ),
        ];
    }
    const obs = ctx.kubectl([
        "kubectl",
        "get",
        "configmap",
        "config-observability",
        "-n",
        "knative-serving",
        "-o",
        "json",
    ]);
    const obsInfra = obs.ok ? undefined : infraFailure(obs);
    if (obsInfra) {
        return [
            mk(
                "metrics-port",
                "Metrics-port collision (queue-proxy :9091)",
                "error",
                obsInfra.detail,
                obsInfra.hint,
            ),
        ];
    }
    // undefined = configmap NotFound (a cluster fact, but one that leaves the
    // protocol undeterminable, not one that implies it).
    const data = obs.ok
        ? (safeJson<{ data?: Record<string, string> }>(obs.stdout)?.data ?? {})
        : undefined;
    const legacy = data?.["metrics.request-metrics-backend-destination"];
    const modern = data?.["request-metrics-protocol"];
    let proto: "prometheus" | "off" | "unknown";
    let protoWhy: string;
    if (legacy === "none" || modern === "none") {
        proto = "off";
        protoWhy = `${
            modern === "none"
                ? "request-metrics-protocol"
                : "metrics.request-metrics-backend-destination"
        } is "none" — queue-proxy leaves :9091 unbound`;
    } else if (modern === "prometheus" || legacy === "prometheus") {
        proto = "prometheus";
        protoWhy = `${
            modern === "prometheus"
                ? "request-metrics-protocol"
                : "metrics.request-metrics-backend-destination"
        } is "prometheus" — queue-proxy binds :9091 for its user-metrics server`;
    } else if (modern !== undefined || legacy !== undefined) {
        proto = "off";
        protoWhy = `request-metrics backend is "${modern ?? legacy}" — only "prometheus" makes queue-proxy bind :9091`;
    } else {
        proto = "unknown";
        protoWhy =
            data === undefined
                ? "configmap knative-serving/config-observability not found, so the request-metrics protocol cannot be determined"
                : "cannot determine whether queue-proxy binds :9091 — neither request-metrics-protocol (serving v0.48+, absent means none) nor metrics.request-metrics-backend-destination (older serving, absent means prometheus) is set, and the default depends on the serving version";
    }

    const apps = ctx.kubectl([
        "kubectl",
        "get",
        "nextapps",
        "--all-namespaces",
        "-o",
        "json",
    ]);
    const appsInfra = apps.ok ? undefined : infraFailure(apps);
    if (appsInfra) {
        return [
            mk(
                "metrics-port",
                "Metrics-port collision (queue-proxy :9091)",
                "error",
                `${appsInfra.detail} — NextApp METRICS_PORT overrides could not be verified`,
                appsInfra.hint,
            ),
        ];
    }
    // A non-infra list failure (CRD not installed yet) means no NextApps exist
    // to collide; the default-port reasoning below still holds.
    const items = apps.ok
        ? (safeJson<{
              items?: {
                  metadata?: { name?: string; namespace?: string };
                  spec?: { env?: Record<string, string> };
              }[];
          }>(apps.stdout)?.items ?? [])
        : [];
    const pinned = items
        .map((i) => ({
            app: `${i.metadata?.namespace ?? "?"}/${i.metadata?.name ?? "?"}`,
            port: Number.parseInt((i.spec?.env?.METRICS_PORT ?? "").trim(), 10),
        }))
        .filter((p) => Number.isInteger(p.port));
    // The whole owned set, not the 9091 literal: 9090 (and the serving ports)
    // are bound UNCONDITIONALLY, so pinning onto them crash-loops regardless of
    // the request-metrics protocol.
    const always = pinned.filter(
        (p) =>
            QUEUE_PROXY_OWNED_PORTS.has(p.port) &&
            p.port !== QUEUE_PROXY_USER_METRICS_PORT,
    );
    const onUserMetrics = pinned.filter(
        (p) => p.port === QUEUE_PROXY_USER_METRICS_PORT,
    );
    const names = (l: typeof pinned) =>
        l.map((p) => `${p.app} (METRICS_PORT=${p.port})`).join(", ");
    const remedyHint =
        `move METRICS_PORT off the queue-proxy-owned ports ` +
        `{8012, 8013, 8022, 8112, 9090, 9091} — knext's default is 9464 and needs no ` +
        `override — or, for :9091 only, disable request metrics in configmap ` +
        `knative-serving/config-observability (request-metrics-protocol: "none" on ` +
        `serving v0.48+, metrics.request-metrics-backend-destination: "none" on older ` +
        `releases)`;
    // HONEST SCOPE for the green paths: a pod still running an image built
    // before the 9464 default binds :9091 with NO env override on its CR, which
    // this read-only check cannot see — so "no collision" is a claim about
    // current builds and visible overrides, never about every running revision.
    const imageCaveat =
        `apps running images built before the 9464 default bind :9091 with no ` +
        `visible override and cannot be detected here — an EADDRINUSE crash-loop on ` +
        `such a revision means: redeploy with a current build`;
    if (always.length > 0) {
        return [
            mk(
                "metrics-port",
                "Metrics-port collision (queue-proxy :9091)",
                "fail",
                `${names(always)} pins METRICS_PORT onto a port queue-proxy binds ` +
                    `UNCONDITIONALLY in every revision pod — the app loses the port race ` +
                    `and crash-loops with EADDRINUSE (#951)`,
                remedyHint,
            ),
        ];
    }
    if (onUserMetrics.length > 0 && proto === "prometheus") {
        return [
            mk(
                "metrics-port",
                "Metrics-port collision (queue-proxy :9091)",
                "fail",
                `${protoWhy} on this cluster, and ${names(onUserMetrics)} pins ` +
                    `METRICS_PORT=9091 — the app loses the port race and crash-loops ` +
                    `with EADDRINUSE (#951)`,
                remedyHint,
            ),
        ];
    }
    if (onUserMetrics.length > 0 && proto === "unknown") {
        return [
            mk(
                "metrics-port",
                "Metrics-port collision (queue-proxy :9091)",
                "warn",
                `${protoWhy}; ${names(onUserMetrics)} pins METRICS_PORT=9091 and WILL ` +
                    `crash-loop with EADDRINUSE if it is bound (#951)`,
                remedyHint,
            ),
        ];
    }
    if (proto === "unknown") {
        return [
            mk(
                "metrics-port",
                "Metrics-port collision (queue-proxy :9091)",
                "pass",
                `${protoWhy}; no NextApp overrides METRICS_PORT onto a queue-proxy-owned ` +
                    `port and current builds default to :9464, which queue-proxy never ` +
                    `binds. Caveat: ${imageCaveat}`,
            ),
        ];
    }
    return [
        mk(
            "metrics-port",
            "Metrics-port collision (queue-proxy :9091)",
            "pass",
            `${protoWhy}; no NextApp overrides METRICS_PORT onto a queue-proxy-owned ` +
                `port and current builds default to :9464. Caveat: ${imageCaveat}`,
        ),
    ];
}
