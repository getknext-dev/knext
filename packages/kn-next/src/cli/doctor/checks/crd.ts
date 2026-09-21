/**
 * (a) NextApp CRD present + served version.
 */

import { infraFailure, safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { NEXTAPP_CRD, SKIP_UNREACHABLE } from "../types";

export function crdCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [mk("crd", "NextApp CRD", "skip", SKIP_UNREACHABLE)];
    }
    const crd = ctx.kubectl([
        "kubectl",
        "get",
        "crd",
        NEXTAPP_CRD,
        "-o",
        "json",
    ]);
    const crdInfra = crd.ok ? undefined : infraFailure(crd);
    if (crdInfra) {
        return [
            mk("crd", "NextApp CRD", "error", crdInfra.detail, crdInfra.hint),
        ];
    }
    if (!crd.ok) {
        return [
            mk(
                "crd",
                "NextApp CRD",
                "fail",
                `${NEXTAPP_CRD} not found — install the operator bundle (kubectl apply --server-side -f install.yaml)`,
                "Install the knext operator bundle (it ships the NextApp CRD): `kubectl apply --server-side -f <operator install.yaml>`, then re-run.",
            ),
        ];
    }
    const parsed = safeJson<{
        spec?: { versions?: { name?: string; served?: boolean }[] };
    }>(crd.stdout);
    const served = (parsed?.spec?.versions ?? []).filter((v) => v.served);
    if (served.length === 0) {
        return [
            mk(
                "crd",
                "NextApp CRD",
                "fail",
                `${NEXTAPP_CRD} exists but serves no version — reinstall the operator bundle`,
                "Reinstall the knext operator bundle — the installed CRD serves no API version, so no NextApp can be applied.",
            ),
        ];
    }
    return [
        mk(
            "crd",
            "NextApp CRD",
            "pass",
            `served version: ${served.map((v) => v.name).join(", ")}`,
        ),
    ];
}
