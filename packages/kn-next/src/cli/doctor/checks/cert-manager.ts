/**
 * (c) cert-manager webhook prereq (the operator bundle ships webhook certs).
 */

import { infraFailure, isReady, safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult, DeploymentJson } from "../types";
import { SKIP_UNREACHABLE } from "../types";

export function certManagerCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [
            mk(
                "cert-manager",
                "cert-manager webhook",
                "skip",
                SKIP_UNREACHABLE,
            ),
        ];
    }
    const cm = ctx.kubectl([
        "kubectl",
        "get",
        "deployment",
        "cert-manager-webhook",
        "-n",
        "cert-manager",
        "-o",
        "json",
    ]);
    const cmInfra = cm.ok ? undefined : infraFailure(cm);
    if (cmInfra) {
        return [
            mk(
                "cert-manager",
                "cert-manager webhook",
                "error",
                cmInfra.detail,
                cmInfra.hint,
            ),
        ];
    }
    if (!cm.ok) {
        return [
            mk(
                "cert-manager",
                "cert-manager webhook",
                "warn",
                "cert-manager-webhook not found — the operator bundle includes webhook Certificates that need cert-manager installed",
            ),
        ];
    }
    if (isReady(safeJson<DeploymentJson>(cm.stdout))) {
        return [
            mk(
                "cert-manager",
                "cert-manager webhook",
                "pass",
                "cert-manager-webhook Ready",
            ),
        ];
    }
    return [
        mk(
            "cert-manager",
            "cert-manager webhook",
            "fail",
            "cert-manager-webhook exists but is not Ready",
        ),
    ];
}
