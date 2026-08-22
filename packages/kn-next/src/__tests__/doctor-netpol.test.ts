/**
 * `kn-next doctor` — NetworkPolicy-enforcement check (#744).
 *
 * The operator reconciles a default-on NetworkPolicy, but flannel (OKE GA,
 * OrbStack) ships no NetworkPolicy controller — there the policy is
 * declarative only, and nothing used to say so. This check detects the
 * cluster's CNI enforcement posture from DaemonSet signatures, read-only, and
 * FAILS HONEST: "cannot determine" is a distinct outcome from "enforced",
 * never folded into it.
 */

import { describe, expect, it } from "vitest";
import {
    type CheckResult,
    classifyCNIEnforcement,
    type KubectlFn,
    type ProbeOutcome,
    runDoctor,
} from "../cli/doctor";

/** Build a stub kubectl keyed on the joined argv (space-separated). */
function stubKubectl(
    table: Record<string, { ok: boolean; stdout?: string; stderr?: string }>,
): KubectlFn {
    return (args) => {
        const key = args.join(" ");
        const hit = table[key];
        if (!hit) {
            return { ok: false, stdout: "", stderr: `no stub for: ${key}` };
        }
        return {
            ok: hit.ok,
            stdout: hit.stdout ?? "",
            stderr: hit.stderr ?? "",
        };
    };
}

const okProbe = async (): Promise<ProbeOutcome> => "ok";

const DS_LIST_KEY = "kubectl get daemonsets --all-namespaces -o json";

const dsListJson = (refs: { namespace: string; name: string }[]) =>
    JSON.stringify({
        items: refs.map((r) => ({
            metadata: { name: r.name, namespace: r.namespace },
        })),
    });

/**
 * The minimal stub table this suite needs: a reachable cluster plus the
 * DaemonSet list under test. Every other probe intentionally misses (their
 * checks are covered by doctor.test.ts) — a miss never crashes runDoctor.
 */
function stubsWithDaemonSets(
    refs: { namespace: string; name: string }[],
): Record<string, { ok: boolean; stdout?: string; stderr?: string }> {
    return {
        "kubectl get --raw /version": { ok: true, stdout: "{}" },
        [DS_LIST_KEY]: { ok: true, stdout: dsListJson(refs) },
    };
}

function netpolCheck(checks: CheckResult[]): CheckResult {
    const c = checks.find((x) => x.id === "netpol");
    expect(c, "doctor must include the netpol check").toBeDefined();
    return c as CheckResult;
}

describe("classifyCNIEnforcement — the pure classifier", () => {
    it.each([
        ["calico-node", "kube-system"],
        ["calico-node", "calico-system"],
        ["cilium", "kube-system"],
        ["kube-router", "kube-system"],
        ["weave-net", "kube-system"],
        ["antrea-agent", "kube-system"],
        ["canal", "kube-system"],
    ])("%s (%s) => enforced", (name, namespace) => {
        const r = classifyCNIEnforcement([
            { namespace: "kube-system", name: "kube-proxy" },
            { namespace, name },
        ]);
        expect(r.verdict).toBe("enforced");
        expect(r.evidence).toContain(name);
        expect(r.evidence).toContain(namespace);
    });

    it.each([
        "kube-flannel-ds",
        "kube-flannel-ds-amd64",
        "flannel",
    ])("flannel alone (%s) => likely-unenforced", (name) => {
        const r = classifyCNIEnforcement([
            { namespace: "kube-system", name: "kube-proxy" },
            { namespace: "kube-flannel", name },
        ]);
        expect(r.verdict).toBe("likely-unenforced");
        expect(r.evidence).toContain(name);
    });

    it("an enforcing agent outvotes a flannel DaemonSet (canal clusters)", () => {
        const r = classifyCNIEnforcement([
            { namespace: "kube-system", name: "kube-flannel-ds" },
            { namespace: "kube-system", name: "calico-node" },
        ]);
        expect(r.verdict).toBe("enforced");
        expect(r.evidence).toContain("calico-node");
    });

    it("nothing recognized => unknown, never a guess", () => {
        const r = classifyCNIEnforcement([
            { namespace: "kube-system", name: "kube-proxy" },
            { namespace: "monitoring", name: "node-exporter" },
        ]);
        expect(r.verdict).toBe("unknown");
    });

    it("evidence is order-independent (deterministic output)", () => {
        const a = classifyCNIEnforcement([
            { namespace: "kube-system", name: "cilium" },
            { namespace: "calico-system", name: "calico-node" },
        ]);
        const b = classifyCNIEnforcement([
            { namespace: "calico-system", name: "calico-node" },
            { namespace: "kube-system", name: "cilium" },
        ]);
        expect(a.evidence).toBe(b.evidence);
    });
});

describe("runDoctor — check (i) NetworkPolicy enforcement", () => {
    it("passes when a policy-enforcing CNI is detected", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(
                stubsWithDaemonSets([
                    { namespace: "kube-system", name: "calico-node" },
                ]),
            ),
            probeImage: okProbe,
        });
        const c = netpolCheck(report.checks);
        expect(c.status).toBe("pass");
        expect(c.detail).toContain("calico-node");
        expect(c.detail).toMatch(/enforced/i);
    });

    it("warns plainly on flannel: the policy is declarative only", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(
                stubsWithDaemonSets([
                    { namespace: "kube-flannel", name: "kube-flannel-ds" },
                ]),
            ),
            probeImage: okProbe,
        });
        const c = netpolCheck(report.checks);
        expect(c.status).toBe("warn");
        // Says plainly what is inert, and names the reference-cluster reality.
        expect(c.detail).toContain("flannel");
        expect(c.detail).toMatch(/declarative only/i);
        expect(c.detail).toMatch(/OKE|OrbStack/);
        expect(c.hint).toMatch(/Calico|Cilium/);
    });

    it("fails honest: no recognizable CNI => cannot determine, treated as unenforced", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(
                stubsWithDaemonSets([
                    { namespace: "kube-system", name: "kube-proxy" },
                ]),
            ),
            probeImage: okProbe,
        });
        const c = netpolCheck(report.checks);
        expect(c.status).toBe("warn");
        expect(c.detail).toMatch(/cannot determine/i);
        expect(c.detail).toMatch(/unenforced/i);
        // Never folded into "enforced".
        expect(c.status).not.toBe("pass");
    });

    it("RBAC-denied DaemonSet list => cannot determine (with the RBAC hint), not an error", async () => {
        const stubs = stubsWithDaemonSets([]);
        stubs[DS_LIST_KEY] = {
            ok: false,
            stderr: 'Error from server (Forbidden): daemonsets.apps is forbidden: User "restricted" cannot list resource "daemonsets" in API group "apps" at the cluster scope',
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        const c = netpolCheck(report.checks);
        expect(c.status).toBe("warn");
        expect(c.detail).toMatch(/cannot determine/i);
        expect(c.detail).toMatch(/unenforced/i);
        expect(c.hint).toMatch(/RBAC|list/i);
    });

    it("a network-flaked probe is an ERROR (could not verify), never a verdict", async () => {
        const stubs = stubsWithDaemonSets([]);
        stubs[DS_LIST_KEY] = {
            ok: false,
            stderr: "Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout",
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        const c = netpolCheck(report.checks);
        expect(c.status).toBe("error");
        expect(report.exitCode).toBe(1);
    });

    it("skips with the shared reason when the cluster is unreachable", async () => {
        const kubectl: KubectlFn = () => ({
            ok: false,
            stdout: "",
            stderr: "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
        });
        const report = await runDoctor({
            kubectl,
            probeImage: okProbe,
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
        });
        const c = netpolCheck(report.checks);
        expect(c.status).toBe("skip");
    });
});
