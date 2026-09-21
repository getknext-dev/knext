/**
 * (f) Knative Serving present.
 */

import { infraFailure } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { KSVC_CRD, SKIP_UNREACHABLE } from "../types";

export function knativeCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [mk("knative", "Knative Serving", "skip", SKIP_UNREACHABLE)];
    }
    const ksvc = ctx.kubectl(["kubectl", "get", "crd", KSVC_CRD, "-o", "json"]);
    const ksvcInfra = ksvc.ok ? undefined : infraFailure(ksvc);
    if (ksvc.ok) {
        return [
            mk("knative", "Knative Serving", "pass", `${KSVC_CRD} CRD present`),
        ];
    }
    if (ksvcInfra) {
        return [
            mk(
                "knative",
                "Knative Serving",
                "error",
                ksvcInfra.detail,
                ksvcInfra.hint,
            ),
        ];
    }
    return [
        mk(
            "knative",
            "Knative Serving",
            "fail",
            `${KSVC_CRD} not found — install Knative Serving + Kourier (see docs/QUICKSTART.md prerequisites)`,
            "Install Knative Serving + the Kourier ingress, then re-run `kn-next doctor`.",
        ),
    ];
}
