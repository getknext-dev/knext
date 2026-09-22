/**
 * (b) operator Deployment Ready — also yields the image for the operator-image
 * check, which it stashes on the shared context.
 */

import { infraFailure, isReady, safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult, DeploymentJson } from "../types";
import { OPERATOR_NAMESPACE, SKIP_UNREACHABLE } from "../types";

export function operatorCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [
            mk("operator", "Operator deployment", "skip", SKIP_UNREACHABLE),
        ];
    }
    const deps_ = ctx.kubectl([
        "kubectl",
        "get",
        "deployments",
        "-n",
        OPERATOR_NAMESPACE,
        "-o",
        "json",
    ]);
    const items = deps_.ok
        ? (safeJson<{ items?: DeploymentJson[] }>(deps_.stdout)?.items ?? [])
        : [];
    const opInfra = deps_.ok ? undefined : infraFailure(deps_);
    if (opInfra) {
        return [
            mk(
                "operator",
                "Operator deployment",
                "error",
                opInfra.detail,
                opInfra.hint,
            ),
        ];
    }
    if (!deps_.ok || items.length === 0) {
        return [
            mk(
                "operator",
                "Operator deployment",
                "fail",
                `no Deployment found in ${OPERATOR_NAMESPACE} — install the operator bundle`,
                "Install the knext operator: `kubectl apply --server-side -f https://github.com/getknext-dev/knext/releases/download/operator-latest/install.yaml`, then re-run.",
            ),
        ];
    }
    const manager =
        items.find((d) =>
            (d.metadata?.name ?? "").includes("controller-manager"),
        ) ?? items[0];
    ctx.operatorImage = manager.spec?.template?.spec?.containers?.[0]?.image;
    if (isReady(manager)) {
        return [
            mk(
                "operator",
                "Operator deployment",
                "pass",
                `${manager.metadata?.name} Ready in ${OPERATOR_NAMESPACE}`,
            ),
        ];
    }
    return [
        mk(
            "operator",
            "Operator deployment",
            "fail",
            `${manager.metadata?.name} is not Ready (readyReplicas=0) — kubectl describe deploy -n ${OPERATOR_NAMESPACE} (ImagePullBackOff? see the image check)`,
            `Inspect it: \`kubectl describe deploy -n ${OPERATOR_NAMESPACE} ${manager.metadata?.name}\`. A common cause is ImagePullBackOff — see the operator-image check.`,
        ),
    ];
}
