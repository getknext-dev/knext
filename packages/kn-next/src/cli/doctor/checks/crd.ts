/**
 * (a) NextApp CRD present + served version, paired against the CRD apiVersion
 * this CLI emits. The CLI and the operator pair by CRD API version, not by
 * package major: a CLI whose emitted version the CRD does not serve cannot
 * apply a NextApp at all.
 */

import { NEXTAPP_API_VERSION } from "../../crd-api-version";
import {
    type CrdDocument,
    type CrdPairing,
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

/**
 * The one-line detail and the repair hint for a CRD that does not serve the
 * version this CLI emits. The fix depends on which side is behind: a CRD that
 * only serves NEWER versions means the CLI must move, not the operator.
 */
function notServedMessage(
    emitted: string,
    crdName: string,
    p: Extract<CrdPairing, { kind: "not-served" }>,
): { detail: string; hint: string } {
    const head = `this CLI emits ${emitted}, but the installed ${crdName} does not serve ${p.emitted} (it serves: ${p.served.join(", ")})`;
    switch (p.direction) {
        case "crd-newer":
            return {
                detail: `${head} — upgrade the CLI to match the operator`,
                hint: `The installed CRD serves only newer versions than this CLI emits: upgrade the CLI (@getknext/core) to a release that emits one of ${p.served.join(", ")} — see ${VERSIONING_DOCS_URL}`,
            };
        case "crd-older":
            return {
                detail: `${head} — upgrade the operator first (operator, then CLI)`,
                hint: `Upgrade the operator/CRD FIRST, then the CLI: install an operator release that serves ${p.emitted}, or use the CLI release that emits one of the served versions — see ${VERSIONING_DOCS_URL}`,
            };
        default:
            return {
                detail: `${head} — upgrade the operator first (operator, then CLI), or upgrade the CLI to match the operator`,
                hint: `Cannot tell which side is behind. If the operator is older, upgrade the operator/CRD FIRST, then the CLI; if the CLI is older, upgrade the CLI (@getknext/core) to a release that emits one of ${p.served.join(", ")} — see ${VERSIONING_DOCS_URL}`,
            };
    }
}

/**
 * `emittedApiVersion` defaults to what the CLI stamps on every NextApp; the
 * parameter exists so the direction logic is testable against emitted versions
 * the constant does not currently take.
 */
export function crdCheck(
    ctx: CheckContext,
    emittedApiVersion: string = NEXTAPP_API_VERSION,
): CheckResult[] {
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
                    `could not read the served versions of ${NEXTAPP_CRD} — the pairing with this CLI (${emittedApiVersion}) cannot be verified`,
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
    const pairing = classifyCrdPairing(emittedApiVersion, served);
    if (pairing.kind === "not-served") {
        const msg = notServedMessage(emittedApiVersion, NEXTAPP_CRD, pairing);
        return [mk("crd", "NextApp CRD", "fail", msg.detail, msg.hint)];
    }
    return [
        mk(
            "crd",
            "NextApp CRD",
            "pass",
            `served version: ${served.join(", ")}; pairs with this CLI (${emittedApiVersion})`,
        ),
    ];
}
