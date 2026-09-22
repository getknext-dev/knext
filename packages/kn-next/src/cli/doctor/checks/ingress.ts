/**
 * (d) ingress-class vs serving reconciler (#208). A KnativeServing CR declaring
 * `kourier.knative.dev` while net-kourier serves
 * `kourier.ingress.networking.knative.dev` makes every KIngress silently skip
 * (routes never program, no error surfaced).
 */

import { infraFailure, isReady, safeJson } from "../kubectl";
import { mk } from "../report";
import type {
    CheckContext,
    CheckResult,
    DeploymentJson,
    InfraFailure,
} from "../types";
import { KOURIER_INGRESS_CLASS, SKIP_UNREACHABLE } from "../types";

export function ingressCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [
            mk("ingress", "Knative ingress-class", "skip", SKIP_UNREACHABLE),
        ];
    }
    const cm = ctx.kubectl([
        "kubectl",
        "get",
        "configmap",
        "config-network",
        "-n",
        "knative-serving",
        "-o",
        "json",
    ]);
    const cnInfra = cm.ok ? undefined : infraFailure(cm);
    if (cnInfra) {
        return [
            mk(
                "ingress",
                "Knative ingress-class",
                "error",
                cnInfra.detail,
                cnInfra.hint,
            ),
        ];
    }
    if (!cm.ok) {
        return [
            mk(
                "ingress",
                "Knative ingress-class",
                "fail",
                "configmap config-network not found in knative-serving — is Knative Serving installed?",
                "install Knative Serving (the config-network ConfigMap ships with it): https://knative.dev/docs/install/",
            ),
        ];
    }
    const data =
        safeJson<{ data?: Record<string, string> }>(cm.stdout)?.data ?? {};
    const ingressClass =
        data["ingress-class"] ??
        data["ingress.class"] ??
        "istio.ingress.networking.knative.dev";

    // Does a kourier reconciler exist? (controller ships in knative-serving on
    // current installs, kourier-system on older ones). #230: a probe-infra
    // failure here must not be read as "no reconciler exists" — track it and
    // error out below.
    let kourierReady = false;
    let kourierInfra: InfraFailure | undefined;
    for (const ns of ["knative-serving", "kourier-system"]) {
        const d = ctx.kubectl([
            "kubectl",
            "get",
            "deployment",
            "net-kourier-controller",
            "-n",
            ns,
            "-o",
            "json",
        ]);
        if (d.ok && isReady(safeJson<DeploymentJson>(d.stdout))) {
            kourierReady = true;
            break;
        }
        if (!d.ok) kourierInfra ??= infraFailure(d);
    }

    if (!kourierReady && kourierInfra) {
        return [
            mk(
                "ingress",
                "Knative ingress-class",
                "error",
                `${kourierInfra.detail} — kourier-reconciler presence could not be verified`,
                kourierInfra.hint,
            ),
        ];
    }
    if (ingressClass === KOURIER_INGRESS_CLASS && kourierReady) {
        return [
            mk(
                "ingress",
                "Knative ingress-class",
                "pass",
                `ingress-class ${ingressClass} is served by net-kourier-controller`,
            ),
        ];
    }
    if (ingressClass === KOURIER_INGRESS_CLASS) {
        return [
            mk(
                "ingress",
                "Knative ingress-class",
                "fail",
                `ingress-class is ${ingressClass} but no Ready net-kourier-controller deployment was found — no reconciler serves this class, routes will never program`,
                "Install or repair net-kourier (the Knative ingress controller) and confirm its controller pods are Ready, then re-run.",
            ),
        ];
    }
    if (kourierReady) {
        return [
            mk(
                "ingress",
                "Knative ingress-class",
                "warn",
                `config-network ingress-class is "${ingressClass}" but net-kourier serves "${KOURIER_INGRESS_CLASS}" — KIngresses will be silently skipped (routes never program, no error surfaced; #208). Fix the class where it is AUTHORED: if a KnativeServing CR manages this cluster, set it there — editing the ConfigMap directly gets clobbered by the KnativeServing operator.`,
            ),
        ];
    }
    return [
        mk(
            "ingress",
            "Knative ingress-class",
            "warn",
            `ingress-class is "${ingressClass}" and no net-kourier reconciler was found — verify a networking layer serving this class is installed (knext installs pin Kourier)`,
        ),
    ];
}
