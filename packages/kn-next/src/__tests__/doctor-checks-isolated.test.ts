/**
 * ISOLATED per-check unit tests for the #1055 decomposition (AC2).
 *
 * The whole point of the decomposition is that a single check can be
 * unit-tested WITHOUT running the `runDoctor` aggregate. Every test here imports
 * one `*Check` function directly from `cli/doctor/checks/*`, builds a fixtured
 * `CheckContext` (or `DoctorDeps` for the cluster gate), and asserts that one
 * check's returned `CheckResult[]` — no `runDoctor` in the loop.
 *
 * The aggregate golden/readonly/reuse pins remain; this is the isolated layer
 * the issue's Problem statement requires ("a single check cannot be unit-tested
 * in isolation").
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { appImageCheck } from "../cli/doctor/checks/app-image";
import { certManagerCheck } from "../cli/doctor/checks/cert-manager";
import { clusterCheck } from "../cli/doctor/checks/cluster";
import { crdCheck } from "../cli/doctor/checks/crd";
import { crdSchemaCheck } from "../cli/doctor/checks/crd-schema";
import { ingressCheck } from "../cli/doctor/checks/ingress";
import { knativeCheck } from "../cli/doctor/checks/knative";
import { kubectlValidationCheck } from "../cli/doctor/checks/kubectl-validation";
import { metricsCheck } from "../cli/doctor/checks/metrics";
import { networkPolicyCheck } from "../cli/doctor/checks/network-policy";
import { operatorCheck } from "../cli/doctor/checks/operator";
import { operatorImageCheck } from "../cli/doctor/checks/operator-image";
import { storageModeCheck } from "../cli/doctor/checks/storage-mode";
import type {
    CheckContext,
    DoctorDeps,
    KubectlFn,
    ManifestProbeFn,
} from "../cli/doctor/types";
import { KOURIER_INGRESS_CLASS } from "../cli/doctor/types";
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

type StubEntry = { ok: boolean; stdout?: string; stderr?: string };

function stubKubectl(table: Record<string, StubEntry>): KubectlFn {
    return (args) => {
        const key = args.join(" ");
        const hit = table[key];
        if (!hit) return { ok: false, stdout: "", stderr: `no stub: ${key}` };
        return {
            ok: hit.ok,
            stdout: hit.stdout ?? "",
            stderr: hit.stderr ?? "",
        };
    };
}

/** Build an isolated CheckContext over a stub table. */
function makeCtx(
    table: Record<string, StubEntry>,
    opts: {
        skipAll?: boolean;
        probeImage?: ManifestProbeFn;
        loadAppConfig?: () => Promise<KnativeNextConfig | undefined>;
        appImageProbeBudgetMs?: number;
        operatorImage?: string;
    } = {},
): CheckContext {
    const kubectl = stubKubectl(table);
    const deps: DoctorDeps = {
        kubectl,
        probeImage: opts.probeImage ?? (async () => "ok"),
        loadAppConfig: opts.loadAppConfig,
        appImageProbeBudgetMs: opts.appImageProbeBudgetMs,
    };
    return {
        deps,
        kubectl,
        skipAll: opts.skipAll ?? false,
        operatorImage: opts.operatorImage,
    };
}

const singleDeployJson = (name: string, ready = 1) =>
    JSON.stringify({
        metadata: { name },
        status: { readyReplicas: ready, replicas: 1 },
    });

const listDeployJson = (name: string, image: string, ready = 1) =>
    JSON.stringify({
        items: [
            {
                metadata: { name },
                spec: { template: { spec: { containers: [{ image }] } } },
                status: { readyReplicas: ready, replicas: 1 },
            },
        ],
    });

function bundledSchemaDoc(): string {
    const crd = YAML.parse(readFileSync(CRD_YAML, "utf-8")) as {
        spec: { versions: { schema: { openAPIV3Schema: unknown } }[] };
    };
    return JSON.stringify({
        components: {
            schemas: {
                "dev.kn-next.apps.v1alpha1.NextApp":
                    crd.spec.versions[0]?.schema.openAPIV3Schema,
            },
        },
    });
}

describe("clusterCheck (isolated)", () => {
    it("PASS when the apiserver answers, reachable=true", () => {
        const deps: DoctorDeps = {
            kubectl: stubKubectl({
                "kubectl get --raw /version": { ok: true, stdout: "{}" },
            }),
            probeImage: async () => "ok",
        };
        const { checks, reachable } = clusterCheck(deps);
        expect(reachable).toBe(true);
        expect(checks[0]?.status).toBe("pass");
        expect(checks[0]?.id).toBe("cluster");
    });

    it("WARN + reachable=false on a refused local dial", () => {
        const deps: DoctorDeps = {
            kubectl: () => ({
                ok: false,
                stdout: "",
                stderr: "connection refused",
            }),
            probeImage: async () => "ok",
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
        };
        const { checks, reachable } = clusterCheck(deps);
        expect(reachable).toBe(false);
        expect(checks[0]?.status).toBe("warn");
    });
});

const VERSION_KEY = "kubectl version --client -o json";

describe("kubectlValidationCheck (isolated)", () => {
    it("PASS on a modern client (>= v1.25)", () => {
        const [r] = kubectlValidationCheck(
            makeCtx({
                [VERSION_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        clientVersion: { gitVersion: "v1.31.2" },
                    }),
                },
            }),
        );
        expect(r?.status).toBe("pass");
        expect(r?.id).toBe("kubectl-validation");
    });

    it("FAIL on an old client (< v1.25)", () => {
        const [r] = kubectlValidationCheck(
            makeCtx({
                [VERSION_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        clientVersion: { gitVersion: "v1.23.0" },
                    }),
                },
            }),
        );
        expect(r?.status).toBe("fail");
    });

    it("WARN when the version is unparseable", () => {
        const [r] = kubectlValidationCheck(
            makeCtx({ [VERSION_KEY]: { ok: true, stdout: "not json" } }),
        );
        expect(r?.status).toBe("warn");
    });
});

describe("storageModeCheck (isolated)", () => {
    it("SKIP when no config in the directory", async () => {
        const [r] = await storageModeCheck(
            makeCtx({}, { loadAppConfig: async () => undefined }),
        );
        expect(r?.status).toBe("skip");
        expect(r?.id).toBe("storage-mode");
    });

    it("PASS naming the bucket when storage is configured", async () => {
        const [r] = await storageModeCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () =>
                        ({
                            storage: { provider: "gcs", bucket: "assets" },
                        }) as unknown as KnativeNextConfig,
                },
            ),
        );
        expect(r?.status).toBe("pass");
        expect(r?.detail).toContain("gcs: assets");
    });

    it("PASS (image-served) when no storage block is set", async () => {
        const [r] = await storageModeCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () =>
                        ({}) as unknown as KnativeNextConfig,
                },
            ),
        );
        expect(r?.status).toBe("pass");
        expect(r?.detail).toContain("served from the image");
    });
});

const CRD_KEY = "kubectl get crd nextapps.apps.kn-next.dev -o json";

describe("crdCheck (isolated)", () => {
    it("SKIP when skipAll", () => {
        const [r] = crdCheck(makeCtx({}, { skipAll: true }));
        expect(r?.status).toBe("skip");
    });

    it("PASS naming the served version", () => {
        const [r] = crdCheck(
            makeCtx({
                [CRD_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        spec: {
                            versions: [{ name: "v1alpha1", served: true }],
                        },
                    }),
                },
            }),
        );
        expect(r?.status).toBe("pass");
        expect(r?.detail).toContain("v1alpha1");
    });

    it("FAIL when the CRD is not found", () => {
        const [r] = crdCheck(
            makeCtx({
                [CRD_KEY]: {
                    ok: false,
                    stderr: 'Error from server (NotFound): crd "x" not found',
                },
            }),
        );
        expect(r?.status).toBe("fail");
    });

    it("ERROR on an infrastructural (auth) failure", () => {
        const [r] = crdCheck(
            makeCtx({
                [CRD_KEY]: {
                    ok: false,
                    stderr: "error: You must be logged in to the server (Unauthorized)",
                },
            }),
        );
        expect(r?.status).toBe("error");
    });
});

const OPENAPI_KEY =
    "kubectl get --raw /openapi/v3/apis/apps.kn-next.dev/v1alpha1";

describe("crdSchemaCheck (isolated)", () => {
    it("SKIP when skipAll", () => {
        const [r] = crdSchemaCheck(makeCtx({}, { skipAll: true }));
        expect(r?.status).toBe("skip");
        expect(r?.id).toBe("crd-schema");
    });

    it("SKIP (visible) when both schema reads are denied", () => {
        const [r] = crdSchemaCheck(
            makeCtx({
                [OPENAPI_KEY]: {
                    ok: false,
                    stderr: 'Error from server (Forbidden): forbidden: User "u" cannot get',
                },
                [CRD_KEY]: {
                    ok: false,
                    stderr: 'Error from server (Forbidden): forbidden: User "u" cannot get',
                },
            }),
        );
        expect(r?.status).toBe("skip");
    });

    it("PASS when the served schema covers every emitted field", () => {
        const [r] = crdSchemaCheck(
            makeCtx({
                [OPENAPI_KEY]: { ok: true, stdout: bundledSchemaDoc() },
            }),
        );
        expect(r?.status).toBe("pass");
    });
});

const OP_KEY = "kubectl get deployments -n kn-next-operator-system -o json";

describe("operatorCheck (isolated)", () => {
    it("SKIP when skipAll", () => {
        const [r] = operatorCheck(makeCtx({}, { skipAll: true }));
        expect(r?.status).toBe("skip");
    });

    it("PASS and STASHES ctx.operatorImage for the image check", () => {
        const ctx = makeCtx({
            [OP_KEY]: {
                ok: true,
                stdout: listDeployJson(
                    "kn-next-operator-controller-manager",
                    OPERATOR_IMAGE,
                ),
            },
        });
        const [r] = operatorCheck(ctx);
        expect(r?.status).toBe("pass");
        expect(ctx.operatorImage).toBe(OPERATOR_IMAGE);
    });

    it("FAIL when no operator Deployment exists", () => {
        const [r] = operatorCheck(
            makeCtx({
                [OP_KEY]: { ok: true, stdout: JSON.stringify({ items: [] }) },
            }),
        );
        expect(r?.status).toBe("fail");
    });
});

describe("certManagerCheck (isolated)", () => {
    const CM_KEY =
        "kubectl get deployment cert-manager-webhook -n cert-manager -o json";
    it("SKIP when skipAll", () => {
        const [r] = certManagerCheck(makeCtx({}, { skipAll: true }));
        expect(r?.status).toBe("skip");
    });
    it("PASS when the webhook is Ready", () => {
        const [r] = certManagerCheck(
            makeCtx({
                [CM_KEY]: {
                    ok: true,
                    stdout: singleDeployJson("cert-manager-webhook"),
                },
            }),
        );
        expect(r?.status).toBe("pass");
    });
    it("WARN when the webhook is absent, with an install-first hint", () => {
        const [r] = certManagerCheck(
            makeCtx({
                [CM_KEY]: {
                    ok: false,
                    stderr: 'Error from server (NotFound): "x" not found',
                },
            }),
        );
        expect(r?.status).toBe("warn");
        // The absent case is a hard prerequisite, so the hint must tell the
        // operator to install cert-manager first and how (kubectl apply URL).
        expect(r?.hint).toBeDefined();
        expect(r?.hint).toContain("cert-manager");
        expect(r?.hint).toMatch(/kubectl apply/);
    });
});

describe("ingressCheck (isolated)", () => {
    const NET_KEY =
        "kubectl get configmap config-network -n knative-serving -o json";
    const KOURIER_KEY =
        "kubectl get deployment net-kourier-controller -n knative-serving -o json";
    it("SKIP when skipAll", () => {
        const [r] = ingressCheck(makeCtx({}, { skipAll: true }));
        expect(r?.status).toBe("skip");
    });
    it("PASS when the kourier class is served by a Ready reconciler", () => {
        const [r] = ingressCheck(
            makeCtx({
                [NET_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        data: { "ingress-class": KOURIER_INGRESS_CLASS },
                    }),
                },
                [KOURIER_KEY]: {
                    ok: true,
                    stdout: singleDeployJson("net-kourier-controller"),
                },
            }),
        );
        expect(r?.status).toBe("pass");
    });
    it("FAIL when the kourier class has no Ready reconciler", () => {
        const [r] = ingressCheck(
            makeCtx({
                [NET_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        data: { "ingress-class": KOURIER_INGRESS_CLASS },
                    }),
                },
                [KOURIER_KEY]: {
                    ok: false,
                    stderr: 'Error from server (NotFound): "x" not found',
                },
            }),
        );
        expect(r?.status).toBe("fail");
    });
});

describe("operatorImageCheck (isolated)", () => {
    it("SKIP when no operator image was resolved", async () => {
        const [r] = await operatorImageCheck(makeCtx({}));
        expect(r?.status).toBe("skip");
        expect(r?.id).toBe("image");
    });
    it("PASS when the stashed image is anonymously pullable", async () => {
        const [r] = await operatorImageCheck(
            makeCtx(
                {},
                { operatorImage: OPERATOR_IMAGE, probeImage: async () => "ok" },
            ),
        );
        expect(r?.status).toBe("pass");
    });
    it("WARN when the stashed image needs auth", async () => {
        const [r] = await operatorImageCheck(
            makeCtx(
                {},
                {
                    operatorImage: OPERATOR_IMAGE,
                    probeImage: async () => "auth-required",
                },
            ),
        );
        expect(r?.status).toBe("warn");
    });

    it("reads the image operatorCheck stashed — the inter-check seam, no runDoctor", async () => {
        const ctx = makeCtx(
            {
                [OP_KEY]: {
                    ok: true,
                    stdout: listDeployJson(
                        "kn-next-operator-controller-manager",
                        OPERATOR_IMAGE,
                    ),
                },
            },
            { probeImage: async () => "ok" },
        );
        // operatorCheck writes ctx.operatorImage; operatorImageCheck reads it.
        operatorCheck(ctx);
        const [r] = await operatorImageCheck(ctx);
        expect(r?.status).toBe("pass");
        expect(r?.detail).toContain(OPERATOR_IMAGE);
    });
});

const NEXTAPPS_KEY = "kubectl get nextapps --all-namespaces -o json";

describe("appImageCheck (isolated)", () => {
    it("SKIP when skipAll", async () => {
        const [r] = await appImageCheck(makeCtx({}, { skipAll: true }));
        expect(r?.status).toBe("skip");
        expect(r?.id).toBe("app-image");
    });
    it("SKIP (nothing to verify) when no NextApps exist", async () => {
        const [r] = await appImageCheck(
            makeCtx({
                [NEXTAPPS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({ items: [] }),
                },
            }),
        );
        expect(r?.status).toBe("skip");
        expect(r?.detail).toContain("nothing to verify");
    });
    it("PASS when a deployed app image is anonymously pullable", async () => {
        const [r] = await appImageCheck(
            makeCtx(
                {
                    [NEXTAPPS_KEY]: {
                        ok: true,
                        stdout: JSON.stringify({
                            items: [
                                {
                                    metadata: {
                                        name: "web",
                                        namespace: "demo",
                                    },
                                    spec: {
                                        image: "ghcr.io/acme/web@sha256:1",
                                    },
                                },
                            ],
                        }),
                    },
                },
                { probeImage: async () => "ok" },
            ),
        );
        expect(r?.status).toBe("pass");
        expect(r?.detail).toContain("anonymously pullable");
    });
    it("SKIP (unverified) when the probe budget is exhausted", async () => {
        const [r] = await appImageCheck(
            makeCtx(
                {
                    [NEXTAPPS_KEY]: {
                        ok: true,
                        stdout: JSON.stringify({
                            items: [
                                {
                                    metadata: {
                                        name: "web",
                                        namespace: "demo",
                                    },
                                    spec: {
                                        image: "ghcr.io/acme/web@sha256:1",
                                    },
                                },
                            ],
                        }),
                    },
                },
                { appImageProbeBudgetMs: 0 },
            ),
        );
        expect(r?.status).toBe("skip");
        expect(r?.detail).toContain("budget ran out");
    });
});

describe("knativeCheck (isolated)", () => {
    const KSVC_KEY = "kubectl get crd services.serving.knative.dev -o json";
    it("SKIP when skipAll", () => {
        const [r] = knativeCheck(makeCtx({}, { skipAll: true }));
        expect(r?.status).toBe("skip");
    });
    it("PASS when the Knative Service CRD is present", () => {
        const [r] = knativeCheck(
            makeCtx({
                [KSVC_KEY]: { ok: true, stdout: JSON.stringify({ spec: {} }) },
            }),
        );
        expect(r?.status).toBe("pass");
    });
    it("FAIL when the Knative Service CRD is absent", () => {
        const [r] = knativeCheck(
            makeCtx({
                [KSVC_KEY]: {
                    ok: false,
                    stderr: 'Error from server (NotFound): "x" not found',
                },
            }),
        );
        expect(r?.status).toBe("fail");
    });
});

describe("metricsCheck (isolated)", () => {
    const OBS_KEY =
        "kubectl get configmap config-observability -n knative-serving -o json";
    it("SKIP when skipAll", () => {
        const [r] = metricsCheck(makeCtx({}, { skipAll: true }));
        expect(r?.status).toBe("skip");
        expect(r?.id).toBe("metrics-port");
    });
    it("PASS when request-metrics are off and no app overrides METRICS_PORT", () => {
        const [r] = metricsCheck(
            makeCtx({
                [OBS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        data: { "request-metrics-protocol": "none" },
                    }),
                },
                [NEXTAPPS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({ items: [] }),
                },
            }),
        );
        expect(r?.status).toBe("pass");
    });
    it("FAIL when an app pins METRICS_PORT onto an unconditional queue-proxy port", () => {
        const [r] = metricsCheck(
            makeCtx({
                [OBS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        data: { "request-metrics-protocol": "none" },
                    }),
                },
                [NEXTAPPS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        items: [
                            {
                                metadata: { name: "web", namespace: "demo" },
                                spec: { env: { METRICS_PORT: "9090" } },
                            },
                        ],
                    }),
                },
            }),
        );
        expect(r?.status).toBe("fail");
    });
});

describe("networkPolicyCheck (isolated)", () => {
    const DS_KEY = "kubectl get daemonsets --all-namespaces -o json";
    it("SKIP when skipAll", () => {
        const [r] = networkPolicyCheck(makeCtx({}, { skipAll: true }));
        expect(r?.status).toBe("skip");
        expect(r?.id).toBe("netpol");
    });
    it("PASS when a policy-capable CNI agent is running", () => {
        const [r] = networkPolicyCheck(
            makeCtx({
                [DS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        items: [
                            {
                                metadata: {
                                    name: "calico-node",
                                    namespace: "kube-system",
                                },
                                status: { numberReady: 3 },
                            },
                        ],
                    }),
                },
            }),
        );
        expect(r?.status).toBe("pass");
    });
    it("WARN when flannel is the CNI (declarative-only NetworkPolicy)", () => {
        const [r] = networkPolicyCheck(
            makeCtx({
                [DS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        items: [
                            {
                                metadata: {
                                    name: "kube-flannel-ds",
                                    namespace: "kube-system",
                                },
                                status: { numberReady: 3 },
                            },
                        ],
                    }),
                },
            }),
        );
        expect(r?.status).toBe("warn");
    });
});
