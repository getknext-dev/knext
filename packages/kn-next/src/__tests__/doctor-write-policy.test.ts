/**
 * `knext doctor` — operator write-policy check.
 *
 * The operator's Secret/ConfigMap writes are bounded by a
 * ValidatingAdmissionPolicy that can be off with nothing saying so: a server
 * older than Kubernetes 1.30 rejects it, an install under another namespace or
 * ServiceAccount name leaves a matchCondition that matches nobody, a prune or an
 * admin deletes it. The operator reports the same verdict as a gauge
 * (knext_operator_write_policy_enforced); this is the CLI half.
 *
 * Two kinds of test: the verdict function is held to the SAME table the Go
 * operator is held to (so the two cannot drift), and the check is driven
 * end-to-end through runDoctor with a stubbed kubectl.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    type CheckResult,
    type KubectlFn,
    type ProbeOutcome,
    runDoctor,
} from "../cli/doctor";
import {
    evaluateWritePolicy,
    type WritePolicyReason,
} from "../cli/doctor/checks/write-policy";

const FIXTURE = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "kn-next-operator",
    "internal",
    "writepolicy",
    "testdata",
    "verdict-cases.json",
);

type Op =
    | { op: "remove-policy" }
    | { op: "remove-binding" }
    | { op: "identity"; value: string }
    | { op: "set"; target: "policy" | "binding"; path: string; value: unknown };

interface Fixture {
    operatorUsername: string;
    policy: Record<string, unknown>;
    binding: Record<string, unknown>;
    cases: {
        name: string;
        ops: Op[];
        enforced: boolean;
        reason: WritePolicyReason;
    }[];
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Fixture;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts.slice(0, -1)) {
        if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
        cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
}

function applyOps(ops: Op[]) {
    let policy: Record<string, unknown> | undefined = clone(fixture.policy);
    let binding: Record<string, unknown> | undefined = clone(fixture.binding);
    let username: string = fixture.operatorUsername;
    const edits: Op[] = [];
    for (const o of ops) {
        if (o.op === "remove-policy") policy = undefined;
        else if (o.op === "remove-binding") binding = undefined;
        else if (o.op === "identity") username = o.value;
        else edits.push(o);
    }
    for (const e of edits) {
        if (e.op !== "set") continue;
        const target = e.target === "policy" ? policy : binding;
        if (target) setPath(target, e.path, e.value);
    }
    return { policy, binding, username };
}

describe("evaluateWritePolicy matches the operator's verdict table", () => {
    it("the table holds both outcomes (a constant could not pass)", () => {
        expect(fixture.cases.some((c) => c.enforced)).toBe(true);
        expect(fixture.cases.some((c) => !c.enforced)).toBe(true);
        expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
    });

    for (const c of fixture.cases) {
        it(c.name, () => {
            const { policy, binding, username } = applyOps(c.ops);
            const v = evaluateWritePolicy(policy, binding, username);
            expect({ enforced: v.enforced, reason: v.reason }).toEqual({
                enforced: c.enforced,
                reason: c.reason,
            });
            if (!v.enforced) expect(v.detail.length).toBeGreaterThan(0);
        });
    }
});

// ---- end to end through runDoctor -------------------------------------------

const OP_NS = "kn-next-operator-system";
const OP_SA = "kn-next-operator-controller-manager";
const POLICY = "kn-next-operator-secret-configmap-writes";
const DEPLOY_KEY = `kubectl get deployments -n ${OP_NS} -o json`;
const POLICY_KEY = `kubectl get validatingadmissionpolicy ${POLICY} -o json`;
const BINDING_KEY = `kubectl get validatingadmissionpolicybinding ${POLICY} -o json`;

type Entry = { ok: boolean; stdout?: string; stderr?: string };

const okProbe = async (): Promise<ProbeOutcome> => "ok";

function stubKubectl(table: Record<string, Entry>): {
    fn: KubectlFn;
    calls: string[];
} {
    const calls: string[] = [];
    return {
        calls,
        fn: (args) => {
            const key = args.join(" ");
            calls.push(key);
            const hit = table[key];
            if (!hit)
                return {
                    ok: false,
                    stdout: "",
                    stderr: `no stub for: ${key}`,
                };
            return {
                ok: hit.ok,
                stdout: hit.stdout ?? "",
                stderr: hit.stderr ?? "",
            };
        },
    };
}

const deployment = (
    over: { sa?: string; env?: { name: string; value: string }[] } = {},
) =>
    JSON.stringify({
        items: [
            {
                metadata: { name: "kn-next-operator-controller-manager" },
                spec: {
                    template: {
                        spec: {
                            serviceAccountName: over.sa ?? OP_SA,
                            containers: [
                                {
                                    name: "manager",
                                    image: "ghcr.io/x/op@sha256:aa",
                                    env: over.env ?? [
                                        {
                                            name: "WRITE_POLICY_NAME",
                                            value: POLICY,
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                },
                status: { readyReplicas: 1, replicas: 1 },
            },
        ],
    });

const NOT_FOUND = (kind: string) =>
    `Error from server (NotFound): ${kind}.admissionregistration.k8s.io "${POLICY}" not found`;

function healthy(
    over: Record<string, Entry> = {},
    versionJson = '{"major":"1","minor":"31","gitVersion":"v1.31.2"}',
): Record<string, Entry> {
    return {
        "kubectl get --raw /version": { ok: true, stdout: versionJson },
        [DEPLOY_KEY]: { ok: true, stdout: deployment() },
        [POLICY_KEY]: { ok: true, stdout: JSON.stringify(fixture.policy) },
        [BINDING_KEY]: { ok: true, stdout: JSON.stringify(fixture.binding) },
        ...over,
    };
}

async function row(
    table: Record<string, Entry>,
): Promise<{ row: CheckResult; calls: string[]; all: CheckResult[] }> {
    const { fn, calls } = stubKubectl(table);
    const report = await runDoctor({ kubectl: fn, probeImage: okProbe });
    const found = report.checks.find((c) => c.id === "write-policy");
    expect(found, "doctor must include the write-policy check").toBeDefined();
    return { row: found as CheckResult, calls, all: report.checks };
}

describe("doctor write-policy check", () => {
    it("PASS when the policy is present, bound with Deny and names the operator", async () => {
        const { row: r } = await row(healthy());
        expect(r.status).toBe("pass");
        expect(r.detail).toContain(POLICY);
    });

    it("WARN naming the missing policy when it is deleted", async () => {
        const { row: r } = await row(
            healthy({
                [POLICY_KEY]: {
                    ok: false,
                    stderr: NOT_FOUND("validatingadmissionpolicies"),
                },
            }),
        );
        expect(r.status).toBe("warn");
        expect(r.detail).toMatch(/does not exist/);
        expect(r.detail).toContain("unrestricted");
        expect(r.hint).toBeTruthy();
    });

    it("WARN when the binding is deleted", async () => {
        const { row: r } = await row(
            healthy({
                [BINDING_KEY]: {
                    ok: false,
                    stderr: NOT_FOUND("validatingadmissionpolicybindings"),
                },
            }),
        );
        expect(r.status).toBe("warn");
        expect(r.detail).toMatch(/binding/i);
        expect(r.detail).toContain("never evaluated");
    });

    it("WARN when the operator runs as a different ServiceAccount than the policy names", async () => {
        const { row: r } = await row(
            healthy({
                [DEPLOY_KEY]: {
                    ok: true,
                    stdout: deployment({ sa: "renamed-operator" }),
                },
            }),
        );
        expect(r.status).toBe("warn");
        expect(r.detail).toContain(
            `system:serviceaccount:${OP_NS}:renamed-operator`,
        );
        expect(r.detail).toMatch(/matches nobody/);
    });

    it("WARN when the binding only audits", async () => {
        const audit = clone(fixture.binding);
        setPath(audit, "spec.validationActions", ["Audit"]);
        const { row: r } = await row(
            healthy({
                [BINDING_KEY]: { ok: true, stdout: JSON.stringify(audit) },
            }),
        );
        expect(r.status).toBe("warn");
        expect(r.detail).toMatch(/Deny/);
    });

    it("WARN naming the 1.30 floor when the server is older, without asking for the policy", async () => {
        const { row: r, calls } = await row(
            healthy(
                {},
                '{"major":"1","minor":"29+","gitVersion":"v1.29.5-gke.1"}',
            ),
        );
        expect(r.status).toBe("warn");
        expect(r.detail).toContain("1.30");
        expect(r.detail).toContain("1.29");
        expect(r.detail).toContain("unrestricted");
        // Nothing to look up on a server that cannot hold the objects.
        expect(calls).not.toContain(POLICY_KEY);
    });

    it("reads the policy name the operator was configured with", async () => {
        const custom = "acme-secret-configmap-writes";
        const customKey = `kubectl get validatingadmissionpolicy ${custom} -o json`;
        const customBindingKey = `kubectl get validatingadmissionpolicybinding ${custom} -o json`;
        const p = clone(fixture.policy);
        setPath(p, "metadata.name", custom);
        const b = clone(fixture.binding);
        setPath(b, "metadata.name", custom);
        setPath(b, "spec.policyName", custom);
        const { row: r } = await row(
            healthy({
                [DEPLOY_KEY]: {
                    ok: true,
                    stdout: deployment({
                        env: [{ name: "WRITE_POLICY_NAME", value: custom }],
                    }),
                },
                [customKey]: { ok: true, stdout: JSON.stringify(p) },
                [customBindingKey]: { ok: true, stdout: JSON.stringify(b) },
            }),
        );
        expect(r.status).toBe("pass");
        expect(r.detail).toContain(custom);
    });

    it("WARN cannot-determine (not pass) when RBAC denies the read", async () => {
        const { row: r } = await row(
            healthy({
                [POLICY_KEY]: {
                    ok: false,
                    stderr: 'Error from server (Forbidden): validatingadmissionpolicies.admissionregistration.k8s.io "x" is forbidden: User "u" cannot get resource',
                },
            }),
        );
        expect(r.status).toBe("warn");
        expect(r.detail).toMatch(/cannot determine/i);
    });

    it("SKIPs when the cluster is unreachable", async () => {
        const { row: r } = await row({
            "kubectl get --raw /version": {
                ok: false,
                stderr: "connection refused",
            },
        });
        expect(r.status).toBe("skip");
    });

    it("SKIPs when there is no operator Deployment to take the identity from", async () => {
        const { row: r } = await row(
            healthy({
                [DEPLOY_KEY]: { ok: true, stdout: '{"items":[]}' },
            }),
        );
        expect(r.status).toBe("skip");
    });

    it("only ever reads (get)", async () => {
        const { calls } = await row(healthy());
        for (const c of calls) {
            expect(
                c.startsWith("kubectl get ") || c.startsWith("kubectl version"),
            ).toBe(true);
        }
        expect(calls).toContain(POLICY_KEY);
        expect(calls).toContain(BINDING_KEY);
    });
});
