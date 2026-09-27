/**
 * (a) NextApp CRD present + served version.
 */

import { actionableDetail } from "../error-format";
import { infraFailure, safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { NEXTAPP_CRD, SKIP_UNREACHABLE } from "../types";

/**
 * #1535: the install step this check names when the CRD is missing. Points at
 * the published install manifest — the same one `operator.ts`'s "no
 * Deployment" branch names — so both dead-ends land the user on one command.
 */
const INSTALL_COMMAND =
    "kubectl apply --server-side -f https://github.com/getknext-dev/knext/releases/download/operator-latest/install.yaml";

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
                actionableDetail(
                    `NextApp CRD not found. Install the operator: ${INSTALL_COMMAND}`,
                    `${NEXTAPP_CRD} not found`,
                    ctx.verbose ?? false,
                ),
                "Install the knext operator bundle (it ships the NextApp CRD), then re-run.",
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
