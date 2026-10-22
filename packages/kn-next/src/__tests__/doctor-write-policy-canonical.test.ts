/**
 * `knext doctor` write-policy check — the parts that are not the shared verdict
 * table: the canonical CEL copy, and what an UNKNOWN is reported as.
 *
 * The check compares a live policy's variables and validations with the ones the
 * bundle ships. That copy lives in write-policy.ts (as does the operator's, in
 * internal/writepolicy/canonical.go); these tests fail if config/admission
 * changes without it, so neither the CLI nor the operator can quietly start
 * reporting a correct policy as modified, or a stale one as fine.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
    type CheckResult,
    type KubectlFn,
    type ProbeOutcome,
    runDoctor,
} from "../cli/doctor";
import { CANONICAL_POLICY_CEL } from "../cli/doctor/checks/write-policy";

const OPERATOR = join(import.meta.dir, "..", "..", "..", "kn-next-operator");
const SHIPPED = join(
    OPERATOR,
    "config",
    "admission",
    "secret-configmap-writes.yaml",
);
const FIXTURE = join(
    OPERATOR,
    "internal",
    "writepolicy",
    "testdata",
    "verdict-cases.json",
);

interface PolicyDoc {
    spec: {
        variables?: { name: string; expression: string }[];
        validations?: { expression: string; messageExpression?: string }[];
    };
}

/** A policy's variables and validations reduced to their CEL. */
function celOf(p: PolicyDoc) {
    return {
        variables: (p.spec.variables ?? []).map((v) => ({
            name: v.name,
            expression: v.expression,
        })),
        validations: (p.spec.validations ?? []).map((v) => ({
            expression: v.expression,
            messageExpression: v.messageExpression ?? "",
        })),
    };
}

describe("the canonical policy CEL", () => {
    const shipped = parseYaml(readFileSync(SHIPPED, "utf-8")) as PolicyDoc;

    it("the shipped policy has CEL to compare (a vacuous comparison could not fail)", () => {
        expect(shipped.spec.variables?.length ?? 0).toBeGreaterThan(0);
        expect(shipped.spec.validations?.length ?? 0).toBeGreaterThan(0);
    });

    it("equals what config/admission ships", () => {
        // JSON round trip: the canonical copy is `as const` (readonly).
        expect(JSON.parse(JSON.stringify(CANONICAL_POLICY_CEL))).toEqual(
            celOf(shipped),
        );
    });

    it("is what the shared table's base policy carries", () => {
        const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8")) as {
            policy: PolicyDoc;
        };
        expect(celOf(fixture.policy)).toEqual(celOf(shipped));
    });
});

// ---- an unknown is not enforced -------------------------------------------

const OP_NS = "kn-next-operator-system";
const NAME = "kn-next-operator-secret-configmap-writes";
const DEPLOY_KEY = `kubectl get deployments -n ${OP_NS} -o json`;
const POLICY_KEY = `kubectl get validatingadmissionpolicy ${NAME} -o json`;
const BINDING_KEY = `kubectl get validatingadmissionpolicybinding ${NAME} -o json`;

type Entry = { ok: boolean; stdout?: string; stderr?: string };
const okProbe = async (): Promise<ProbeOutcome> => "ok";

const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8")) as {
    policy: unknown;
    binding: unknown;
};

/** A deployment with NO WRITE_POLICY_NAME env: an operator from before the check. */
const deploymentWithoutEnv = JSON.stringify({
    items: [
        {
            metadata: {
                name: "kn-next-operator-controller-manager",
                namespace: OP_NS,
            },
            spec: {
                template: {
                    spec: {
                        serviceAccountName:
                            "kn-next-operator-controller-manager",
                        containers: [
                            {
                                name: "manager",
                                image: "ghcr.io/x/op@sha256:aa",
                            },
                        ],
                    },
                },
            },
            status: { readyReplicas: 1, replicas: 1 },
        },
    ],
});

function table(over: Record<string, Entry> = {}): Record<string, Entry> {
    return {
        "kubectl get --raw /version": {
            ok: true,
            stdout: '{"major":"1","minor":"31","gitVersion":"v1.31.2"}',
        },
        [DEPLOY_KEY]: { ok: true, stdout: deploymentWithoutEnv },
        [POLICY_KEY]: { ok: true, stdout: JSON.stringify(fixture.policy) },
        [BINDING_KEY]: { ok: true, stdout: JSON.stringify(fixture.binding) },
        ...over,
    };
}

async function writePolicyRow(t: Record<string, Entry>): Promise<CheckResult> {
    const kubectl: KubectlFn = (args) => {
        const hit = t[args.join(" ")];
        return hit
            ? {
                  ok: hit.ok,
                  stdout: hit.stdout ?? "",
                  stderr: hit.stderr ?? "",
              }
            : {
                  ok: false,
                  stdout: "",
                  stderr: `no stub for: ${args.join(" ")}`,
              };
    };
    const report = await runDoctor({ kubectl, probeImage: okProbe });
    const found = report.checks.find((c) => c.id === "write-policy");
    expect(found).toBeDefined();
    return found as CheckResult;
}

describe("doctor write-policy: unknown means not enforced", () => {
    it("an operator Deployment with no WRITE_POLICY_NAME is checked under the bundle's rendered name", async () => {
        // The Go flag default is the UNPREFIXED base name (it runs inside the
        // operator, whose env the bundle always sets); doctor, which may meet an
        // operator from before the env existed, falls back to the name the
        // bundle renders. They differ on purpose.
        const r = await writePolicyRow(table());
        expect(r.status).toBe("pass");
        expect(r.detail).toContain(NAME);
    });

    it("an unclassifiable read failure WARNs (it does not skip)", async () => {
        const r = await writePolicyRow(
            table({
                [POLICY_KEY]: {
                    ok: false,
                    stderr: "something went sideways that matches no known signature",
                },
            }),
        );
        expect(r.status).toBe("warn");
        expect(r.detail).toMatch(/not verified/i);
        expect(r.detail).toMatch(/unrestricted/i);
        expect(r.hint).toBeTruthy();
    });

    it("an unparseable policy WARNs (it does not skip)", async () => {
        const r = await writePolicyRow(
            table({ [POLICY_KEY]: { ok: true, stdout: "<<not json>>" } }),
        );
        expect(r.status).toBe("warn");
        expect(r.detail).toMatch(/unreadable/i);
        expect(r.detail).toMatch(/unrestricted/i);
    });

    it("an unparseable binding WARNs (it does not skip)", async () => {
        const r = await writePolicyRow(
            table({ [BINDING_KEY]: { ok: true, stdout: "" } }),
        );
        expect(r.status).toBe("warn");
        expect(r.detail).toMatch(/unreadable/i);
    });
});
