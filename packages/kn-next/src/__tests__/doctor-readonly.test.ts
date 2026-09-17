/**
 * ADR-0001 read-only pin for `kn-next doctor` (#1055).
 *
 * The operator is the single source of truth for cluster state; `doctor` is a
 * PREFLIGHT and must never mutate the cluster. Every kubectl call it issues is
 * a `get` (or `get --raw`) or a client-side `version`. This test drives
 * `runDoctor` through the paths that touch the most verbs — a fully healthy
 * cluster with a deployed NextApp whose image is private (forcing the app
 * ServiceAccount + namespace-Secret reads) — and FAILS if any invocation uses a
 * mutating verb (apply/patch/delete/create/replace/edit/annotate/label) or a
 * server-side dry-run flag.
 *
 * If a future edit makes doctor write to the cluster, this reddens.
 */

import { describe, expect, it } from "bun:test";
import {
    KOURIER_INGRESS_CLASS,
    type KubectlFn,
    type ManifestProbeFn,
    runDoctor,
} from "../cli/doctor";

const READ_ONLY_VERBS = new Set(["get", "version"]);
const MUTATING_TOKENS = [
    "apply",
    "patch",
    "delete",
    "create",
    "replace",
    "edit",
    "annotate",
    "label",
    "--dry-run",
    "--dry-run=server",
    "--server-side",
];

type StubEntry = { ok: boolean; stdout?: string; stderr?: string };

const singleDeployJson = (name: string, ready = 1) =>
    JSON.stringify({
        metadata: { name },
        status: { readyReplicas: ready, replicas: 1 },
    });

const deployJson = (name: string, image: string) =>
    JSON.stringify({
        items: [
            {
                metadata: { name },
                spec: { template: { spec: { containers: [{ image }] } } },
                status: { readyReplicas: 1, replicas: 1 },
            },
        ],
    });

/**
 * A cluster fixture that exercises the app-image credential paths: the app
 * image is private (probe → auth-required), so doctor reads the app SA and the
 * namespace Secrets — still all `get`s.
 */
function stubs(): Record<string, StubEntry> {
    return {
        "kubectl get --raw /version": { ok: true, stdout: "{}" },
        "kubectl version --client -o json": {
            ok: true,
            stdout: JSON.stringify({
                clientVersion: { gitVersion: "v1.31.2" },
            }),
        },
        "kubectl get crd nextapps.apps.kn-next.dev -o json": {
            ok: true,
            stdout: JSON.stringify({
                spec: { versions: [{ name: "v1alpha1", served: true }] },
            }),
        },
        "kubectl get --raw /openapi/v3/apis/apps.kn-next.dev/v1alpha1": {
            ok: false,
            stderr: 'Error from server (Forbidden): forbidden: User "u" cannot get',
        },
        "kubectl get deployments -n kn-next-operator-system -o json": {
            ok: true,
            stdout: deployJson("kn-next-operator-controller-manager", "x"),
        },
        "kubectl get deployment cert-manager-webhook -n cert-manager -o json": {
            ok: true,
            stdout: singleDeployJson("cert-manager-webhook"),
        },
        "kubectl get configmap config-network -n knative-serving -o json": {
            ok: true,
            stdout: JSON.stringify({
                data: { "ingress-class": KOURIER_INGRESS_CLASS },
            }),
        },
        "kubectl get deployment net-kourier-controller -n knative-serving -o json":
            { ok: true, stdout: singleDeployJson("net-kourier-controller") },
        "kubectl get crd services.serving.knative.dev -o json": {
            ok: true,
            stdout: JSON.stringify({ spec: {} }),
        },
        "kubectl get configmap config-observability -n knative-serving -o json":
            {
                ok: true,
                stdout: JSON.stringify({
                    data: { "request-metrics-protocol": "none" },
                }),
            },
        "kubectl get nextapps --all-namespaces -o json": {
            ok: true,
            stdout: JSON.stringify({
                items: [
                    {
                        metadata: { name: "web", namespace: "demo" },
                        spec: { image: "private.example.com/web:1", env: {} },
                    },
                ],
            }),
        },
        "kubectl get serviceaccount web-sa -n demo -o json": {
            ok: true,
            stdout: JSON.stringify({ imagePullSecrets: [] }),
        },
        "kubectl get secrets -n demo --field-selector type=kubernetes.io/dockerconfigjson -o name":
            { ok: true, stdout: "" },
        "kubectl get daemonsets --all-namespaces -o json": {
            ok: true,
            stdout: JSON.stringify({ items: [] }),
        },
    };
}

describe("doctor is READ-ONLY (ADR-0001)", () => {
    it("issues only get/version verbs — never a mutating verb or dry-run", async () => {
        const calls: string[][] = [];
        const table = stubs();
        const kubectl: KubectlFn = (args) => {
            calls.push([...args]);
            const key = args.join(" ");
            const hit = table[key];
            return hit
                ? {
                      ok: hit.ok,
                      stdout: hit.stdout ?? "",
                      stderr: hit.stderr ?? "",
                  }
                : { ok: false, stdout: "", stderr: `no stub for: ${key}` };
        };
        // A private image forces the SA/Secret reads.
        const probeImage: ManifestProbeFn = async () => "auth-required";

        await runDoctor({
            kubectl,
            probeImage,
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
            loadAppConfig: async () => undefined,
        });

        expect(calls.length).toBeGreaterThan(0);
        for (const args of calls) {
            // args[0] is the literal "kubectl"; args[1] is the verb.
            expect(args[0]).toBe("kubectl");
            const verb = args[1];
            expect(
                READ_ONLY_VERBS.has(verb ?? ""),
                `non-read-only verb "${verb}" in: ${args.join(" ")}`,
            ).toBe(true);
            for (const bad of MUTATING_TOKENS) {
                expect(
                    args.includes(bad),
                    `mutating token "${bad}" in: ${args.join(" ")}`,
                ).toBe(false);
            }
        }
        // Prove the SA + Secret credential paths actually ran (else the pin
        // would be vacuous on the verbs that matter most).
        const joined = calls.map((a) => a.join(" "));
        expect(
            joined.some((c) => c.includes("get serviceaccount web-sa")),
        ).toBe(true);
        expect(joined.some((c) => c.includes("get secrets -n demo"))).toBe(
            true,
        );
    });
});
