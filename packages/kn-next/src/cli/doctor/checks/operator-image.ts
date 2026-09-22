/**
 * (e) operator image pullability (#198) — a private ghcr package
 * ImagePullBackOffs every fresh cluster the quickstart touches. Reads the image
 * ref the operator check stashed on the context.
 */

import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { SKIP_UNREACHABLE } from "../types";

export async function operatorImageCheck(
    ctx: CheckContext,
): Promise<CheckResult[]> {
    if (ctx.skipAll || !ctx.operatorImage) {
        return [
            mk(
                "image",
                "Operator image pullable",
                "skip",
                ctx.skipAll
                    ? SKIP_UNREACHABLE
                    : "no operator image ref resolved (operator check failed) — skipped",
            ),
        ];
    }
    const outcome = await ctx.deps.probeImage(ctx.operatorImage);
    switch (outcome) {
        case "ok":
            return [
                mk(
                    "image",
                    "Operator image pullable",
                    "pass",
                    `${ctx.operatorImage} is anonymously pullable`,
                ),
            ];
        case "auth-required":
            return [
                mk(
                    "image",
                    "Operator image pullable",
                    "warn",
                    `${ctx.operatorImage} is NOT anonymously pullable — fresh nodes need an imagePullSecret, or the registry package must be public (#198)`,
                ),
            ];
        case "not-found":
            return [
                mk(
                    "image",
                    "Operator image pullable",
                    "fail",
                    `${ctx.operatorImage} does not exist on the registry — the running pods hold a cached image that new nodes cannot pull`,
                    "rebuild and republish the operator image, or repoint the CR to a tag/digest that exists on the registry",
                ),
            ];
        default:
            return [
                mk(
                    "image",
                    "Operator image pullable",
                    "skip",
                    "registry unreachable (offline?) — pullability not verified",
                ),
            ];
    }
}
