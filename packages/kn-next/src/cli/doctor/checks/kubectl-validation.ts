/**
 * (g) client kubectl strict-validation support. LOCAL and read-only, so it
 * runs even when the cluster is unreachable (it never touches the apiserver).
 * `kn-next deploy` applies the NextApp CR with an explicit `--validate=strict`
 * so a field the operator's CRD does not know is REJECTED instead of silently
 * pruned; on kubectl < v1.25 that flag value does not exist, so the deploy
 * cannot make that guarantee.
 */

import {
    parseKubectlClientVersion,
    supportsStrictValidation,
} from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { MIN_STRICT_VALIDATION_KUBECTL } from "../types";

export function kubectlValidationCheck(ctx: CheckContext): CheckResult[] {
    const ver = ctx.kubectl(["kubectl", "version", "--client", "-o", "json"]);
    const parsed = ver.ok ? parseKubectlClientVersion(ver.stdout) : undefined;
    if (!parsed) {
        return [
            mk(
                "kubectl-validation",
                "kubectl strict validation",
                "warn",
                "could not determine the kubectl client version — unable to confirm that the CR apply can be strictly validated",
                "run `kubectl version --client` and upgrade to >= v1.25 if older",
            ),
        ];
    }
    if (supportsStrictValidation(parsed)) {
        return [
            mk(
                "kubectl-validation",
                "kubectl strict validation",
                "pass",
                `client ${parsed.display} — the CR apply asserts --validate=strict (unknown fields are rejected, never silently pruned)`,
            ),
        ];
    }
    return [
        mk(
            "kubectl-validation",
            "kubectl strict validation",
            "fail",
            `client ${parsed.display} is older than v${MIN_STRICT_VALIDATION_KUBECTL.major}.${MIN_STRICT_VALIDATION_KUBECTL.minor} — before v1.25 --validate is a BOOLEAN, so \`kn-next deploy\` fails on this client at flag parsing, before it contacts the apiserver. Upgrade kubectl`,
            `upgrade kubectl to >= v${MIN_STRICT_VALIDATION_KUBECTL.major}.${MIN_STRICT_VALIDATION_KUBECTL.minor}`,
        ),
    ];
}
