/**
 * `doctor --ci-kubeconfig <path>` (#1533) — reuse the ONE exec-plugin /
 * cloud-credential classifier `init-ci --push-secret` and the action
 * preflight also use, so a user can check a kubeconfig BEFORE wiring it into
 * CI at all.
 *
 * Unlike every other doctor check, this one is a LOCAL FILE READ, not a
 * cluster call — it does not participate in the `ctx.skipAll` cluster gate,
 * and it is OPT-IN: absent `--ci-kubeconfig`, this module contributes NO row
 * at all, which is what keeps `doctor-golden.test.ts`'s pinned row set
 * byte-identical for every invocation that does not pass the flag.
 */
import { readFileSync } from "node:fs";
import { classifyKubeconfigSafety } from "../../ci/kubeconfig-safety";
import { mk } from "../report";
import type { CheckResult } from "../types";

const ID = "ci-kubeconfig";
const TITLE = "CI kubeconfig safety";

export function ciKubeconfigCheck(
    path: string | undefined,
    readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): CheckResult[] {
    if (path === undefined) return [];

    let raw: string;
    try {
        raw = readFile(path);
    } catch (err) {
        return [
            mk(
                ID,
                TITLE,
                "error",
                `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
                "check the path and file permissions",
            ),
        ];
    }

    const verdict = classifyKubeconfigSafety(raw);
    if (!verdict.ok) {
        return [
            mk(
                ID,
                TITLE,
                "fail",
                verdict.reason ?? "refused",
                "generate a scoped kubeconfig with `kn-next init-ci` instead — it prints the exact commands and never needs a cloud CLI",
            ),
        ];
    }

    return [
        mk(
            ID,
            TITLE,
            "pass",
            `${path} does not need cloud-account credentials`,
        ),
    ];
}
