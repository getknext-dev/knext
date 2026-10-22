/**
 * kubectl stub entries that make the `write-policy` doctor row PASS on the
 * shared "healthy cluster" fixtures: the bundle's policy and binding, confining
 * the identity those fixtures' operator Deployment runs as (no
 * serviceAccountName, so the pod runs as `default`).
 *
 * A fixture that omits them gets a SKIP row ("could not read"), not a pass, so
 * a healthy-cluster test that forgot them would fail its all-pass assertion.
 */

import { CANONICAL_POLICY_CEL } from "../cli/doctor/checks/write-policy";

const NAME = "kn-next-operator-secret-configmap-writes";

export const WRITE_POLICY_STUBS: Record<
    string,
    { ok: boolean; stdout?: string; stderr?: string }
> = {
    [`kubectl get validatingadmissionpolicy ${NAME} -o json`]: {
        ok: true,
        stdout: JSON.stringify({
            metadata: { name: NAME },
            spec: {
                failurePolicy: "Fail",
                variables: CANONICAL_POLICY_CEL.variables,
                validations: CANONICAL_POLICY_CEL.validations,
                matchConstraints: {
                    resourceRules: [
                        {
                            apiGroups: [""],
                            apiVersions: ["v1"],
                            operations: ["CREATE", "UPDATE", "DELETE"],
                            resources: ["secrets", "configmaps"],
                        },
                    ],
                },
                matchConditions: [
                    {
                        name: "request-is-from-the-operator",
                        expression:
                            "request.userInfo.username == 'system:serviceaccount:' + 'kn-next-operator-system' + ':' + 'default'",
                    },
                ],
            },
        }),
    },
    [`kubectl get validatingadmissionpolicybinding ${NAME} -o json`]: {
        ok: true,
        stdout: JSON.stringify({
            metadata: { name: NAME },
            spec: { policyName: NAME, validationActions: ["Deny", "Audit"] },
        }),
    },
};
