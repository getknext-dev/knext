/**
 * (a) NextApp CRD present + served version, paired against the CRD apiVersion
 * this CLI emits. The CLI and the operator pair by CRD API version, not by
 * package major: a CLI whose emitted version the CRD does not serve cannot
 * apply a NextApp at all.
 */

import { NEXTAPP_API_VERSION } from "../../cr-builder";
import {
    type CrdDocument,
    classifyCrdPairing,
    servedCrdVersions,
} from "../crd-version";
import { actionableDetail } from "../error-format";
import { infraFailure, safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { NEXTAPP_CRD, SKIP_UNREACHABLE, VERSIONING_DOCS_URL } from "../types";

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
    const served = servedCrdVersions(safeJson<CrdDocument>(crd.stdout));
    if (served === undefined) {
        // Fail closed: output we cannot parse is not evidence of a pairing.
        return [
            mk(
                "crd",
                "NextApp CRD",
                "fail",
                actionableDetail(
                    `could not read the served versions of ${NEXTAPP_CRD} — the pairing with this CLI (${NEXTAPP_API_VERSION}) cannot be verified`,
                    `kubectl returned output with no spec.versions list: ${crd.stdout.slice(0, 200)}`,
                    ctx.verbose ?? false,
                ),
                "Re-run with --verbose to see what kubectl returned; if the CRD is damaged, reinstall the knext operator bundle.",
            ),
        ];
    }
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
    const pairing = classifyCrdPairing(NEXTAPP_API_VERSION, served);
    if (pairing.kind === "not-served") {
        return [
            mk(
                "crd",
                "NextApp CRD",
                "fail",
                `this CLI emits ${NEXTAPP_API_VERSION}, but the installed ${NEXTAPP_CRD} does not serve ${pairing.emitted} (it serves: ${served.join(", ")}) — upgrade the operator first (operator, then CLI)`,
                `Upgrade the operator/CRD FIRST, then the CLI: install an operator release that serves ${pairing.emitted}, or use the CLI release that emits one of the served versions — see ${VERSIONING_DOCS_URL}`,
            ),
        ];
    }
    return [
        mk(
            "crd",
            "NextApp CRD",
            "pass",
            `served version: ${served.join(", ")}; pairs with this CLI (${NEXTAPP_API_VERSION})`,
        ),
    ];
}
