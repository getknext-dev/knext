/**
 * GOLDEN behaviour pin for the doctor decomposition (#1055).
 *
 * This is the byte-identical safety net that lets `cli/doctor.ts` be split into
 * `cli/doctor/**` modules with ZERO behaviour change. It drives `runDoctor`
 * through a fully-fixtured `DoctorDeps` across the representative scenarios and
 * snapshots BOTH:
 *   - the exact `formatDoctorTable(report.checks)` string a user sees, and
 *   - the ordered `report.checks` array (id/status/detail/hint per row).
 *
 * The ordering of `report.checks` is load-bearing (it is the row order in the
 * table), so the array snapshot pins it explicitly. If the decomposition
 * reorders, drops, or reworders a single check, one of these snapshots reddens.
 *
 * Every dep is injected — kubectl, the image probe, the kubeconfig inspector,
 * the app-config loader, the probe budget — so the snapshots never depend on
 * the machine's ~/.kube/config, cwd, or network.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
    type CheckResult,
    type DoctorReport,
    formatDoctorTable,
    KOURIER_INGRESS_CLASS,
    type KubectlFn,
    type ManifestProbeFn,
    runDoctor,
} from "../cli/doctor";
import type { KnativeNextConfig } from "../config";

const HERE = dirname(fileURLToPath(import.meta.url));
const CRD_YAML = join(
    HERE,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "kn-next-operator",
    "config",
    "crd",
    "bases",
    "apps.kn-next.dev_nextapps.yaml",
);

const OPERATOR_IMAGE =
    "ghcr.io/getknext-dev/kn-next-operator@sha256:75be42bb6b4c6d03c902b4fc90b36b246cc6cacf2233926fa183a6051521a99d";
const APP_IMAGE =
    "ghcr.io/getknext-dev/web@sha256:1111111111111111111111111111111111111111111111111111111111111111";

type StubEntry = { ok: boolean; stdout?: string; stderr?: string };

function stubKubectl(table: Record<string, StubEntry>): KubectlFn {
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

const deployJson = (name: string, image: string, ready = 1) =>
    JSON.stringify({
        items: [
            {
                metadata: { name },
                spec: { template: { spec: { containers: [{ image }] } } },
                status: { readyReplicas: ready, replicas: 1 },
            },
        ],
    });

const singleDeployJson = (name: string, ready = 1) =>
    JSON.stringify({
        metadata: { name },
        status: { readyReplicas: ready, replicas: 1 },
    });

/** The v1alpha1 structural schema from the CRD this repo ships. */
function bundledCRDSchema(): unknown {
    const crd = YAML.parse(readFileSync(CRD_YAML, "utf-8")) as {
        spec: { versions: { schema: { openAPIV3Schema: unknown } }[] };
    };
    return crd.spec.versions[0]?.schema.openAPIV3Schema;
}

/** A healthy cluster fixture WITH one deployed NextApp (so app-image runs). */
function healthyStubs(
    schema: unknown = bundledCRDSchema(),
): Record<string, StubEntry> {
    return {
        "kubectl get --raw /version": { ok: true, stdout: "{}" },
        "kubectl version --client -o json": {
            ok: true,
            stdout: JSON.stringify({
                clientVersion: {
                    major: "1",
                    minor: "31",
                    gitVersion: "v1.31.2",
                },
            }),
        },
        "kubectl get crd nextapps.apps.kn-next.dev -o json": {
            ok: true,
            stdout: JSON.stringify({
                spec: {
                    versions: [
                        { name: "v1alpha1", served: true, storage: true },
                    ],
                },
            }),
        },
        "kubectl get --raw /openapi/v3/apis/apps.kn-next.dev/v1alpha1": {
            ok: true,
            stdout: JSON.stringify({
                components: {
                    schemas: { "dev.kn-next.apps.v1alpha1.NextApp": schema },
                },
            }),
        },
        "kubectl get deployments -n kn-next-operator-system -o json": {
            ok: true,
            stdout: deployJson(
                "kn-next-operator-controller-manager",
                OPERATOR_IMAGE,
            ),
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
                        spec: { image: APP_IMAGE, env: {} },
                    },
                ],
            }),
        },
        "kubectl get daemonsets --all-namespaces -o json": {
            ok: true,
            stdout: JSON.stringify({
                items: [
                    {
                        metadata: {
                            name: "calico-node",
                            namespace: "kube-system",
                        },
                        status: {
                            desiredNumberScheduled: 3,
                            numberReady: 3,
                        },
                    },
                ],
            }),
        },
    };
}

const okProbe: ManifestProbeFn = async () => "ok";

const storageConfig = {
    storage: { provider: "gcs", bucket: "assets" },
} as unknown as KnativeNextConfig;

/** id/status/detail/hint per row, in order — the load-bearing shape. */
function rows(report: DoctorReport): CheckResult[] {
    return report.checks.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        detail: c.detail,
        ...(c.hint ? { hint: c.hint } : {}),
    }));
}

function pin(report: DoctorReport) {
    expect(formatDoctorTable(report.checks)).toMatchSnapshot("table");
    expect(rows(report)).toMatchSnapshot("rows");
    expect(report.exitCode).toMatchSnapshot("exitCode");
}

describe("doctor golden output (#1055 byte-identical pin)", () => {
    it("reachable — all checks pass (storage configured, app anonymously pullable)", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubs()),
            probeImage: okProbe,
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
            loadAppConfig: async () => storageConfig,
        });
        pin(report);
    });

    it("unreachable — reachability gate WARNs, every cluster check SKIPs, exit 0", async () => {
        const kubectl: KubectlFn = () => ({
            ok: false,
            stdout: "",
            stderr: "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
        });
        const report = await runDoctor({
            kubectl,
            probeImage: okProbe,
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
            loadAppConfig: async () => undefined,
        });
        pin(report);
    });

    it("auth-failure — the reachability gate reports a credentials failure", async () => {
        const kubectl: KubectlFn = () => ({
            ok: false,
            stdout: "",
            stderr: "error: You must be logged in to the server (Unauthorized)",
        });
        const report = await runDoctor({
            kubectl,
            probeImage: okProbe,
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
            loadAppConfig: async () => undefined,
        });
        pin(report);
    });

    it("forbidden — the reachability gate reports an RBAC denial", async () => {
        const kubectl: KubectlFn = () => ({
            ok: false,
            stdout: "",
            stderr: 'Error from server (Forbidden): nextapps.apps.kn-next.dev is forbidden: User "u" cannot get resource "nextapps"',
        });
        const report = await runDoctor({
            kubectl,
            probeImage: okProbe,
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
            loadAppConfig: async () => undefined,
        });
        pin(report);
    });

    it("budget-exhausted — the app-image probe budget of 0 leaves images unverified", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubs()),
            probeImage: okProbe,
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
            loadAppConfig: async () => storageConfig,
            appImageProbeBudgetMs: 0,
        });
        pin(report);
    });

    it("crd-schema — an installed CRD missing an emitted field FAILs and names it", async () => {
        const schema = bundledCRDSchema() as {
            properties: {
                spec: {
                    properties: {
                        database: { properties: Record<string, unknown> };
                    };
                };
            };
        };
        delete schema.properties.spec.properties.database.properties
            .roSecretRef;
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubs(schema)),
            probeImage: okProbe,
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
            loadAppConfig: async () => storageConfig,
        });
        pin(report);
    });
});
