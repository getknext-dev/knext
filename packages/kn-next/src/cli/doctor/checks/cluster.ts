/**
 * (gate) Is the apiserver reachable at all? A failed gate keeps the documented
 * degrade path (WARN + all checks SKIP, exit 0) — but #230: when the failure is
 * clearly credentials, say so instead of leaving the user to guess from
 * "unreachable". Finding 1c: an absent/context-less kubeconfig or a refused
 * local dial is reported as "no cluster connected yet", not a network flake.
 */

import {
    classifyKubectlFailure,
    diagnoseNoCluster,
    infraFailure,
    inspectKubeconfig,
} from "../kubectl";
import { mk } from "../report";
import type { CheckResult, DoctorDeps } from "../types";

/**
 * Runs the reachability gate. Returns the single cluster CheckResult AND the
 * derived `reachable` flag the orchestrator turns into `skipAll`.
 */
export function clusterCheck(deps: DoctorDeps): {
    checks: CheckResult[];
    reachable: boolean;
} {
    const version = deps.kubectl(["kubectl", "get", "--raw", "/version"]);
    const reachable = version.ok;
    if (reachable) {
        return {
            reachable,
            checks: [
                mk(
                    "cluster",
                    "Cluster reachable",
                    "pass",
                    "apiserver responded",
                ),
            ],
        };
    }
    // #230 keeps precedence: auth/RBAC-classified failures imply a
    // configured cluster, so they keep their specific hints. Everything
    // else consults the LOCAL kubeconfig (finding 1c) before falling
    // back to the flake hint.
    const cls = classifyKubectlFailure(version.stderr);
    const noCluster =
        cls === "auth" || cls === "forbidden"
            ? undefined
            : diagnoseNoCluster(
                  version.stderr,
                  (deps.inspectKubeconfig ?? inspectKubeconfig)(),
              );
    return {
        reachable,
        checks: [
            mk(
                "cluster",
                "Cluster reachable",
                "warn",
                noCluster?.detail ??
                    `apiserver unreachable (${version.stderr.trim().slice(0, 120) || "no kubectl context?"}) — all cluster checks skipped`,
                noCluster?.hint ?? infraFailure(version)?.hint,
            ),
        ],
    };
}
