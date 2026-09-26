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
import {
    extractNodeEntryMarker,
    nodeEntryStalenessCheck,
} from "../cli/doctor/checks/node-entry-staleness";
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
        readNodeEntryFile?: () => string | undefined;
        readNodeEntryTemplate?: () => string | undefined;
    } = {},
): CheckContext {
    const kubectl = stubKubectl(table);
    const deps: DoctorDeps = {
        kubectl,
        probeImage: opts.probeImage ?? (async () => "ok"),
        loadAppConfig: opts.loadAppConfig,
        appImageProbeBudgetMs: opts.appImageProbeBudgetMs,
        readNodeEntryFile: opts.readNodeEntryFile,
        readNodeEntryTemplate: opts.readNodeEntryTemplate,
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
        expect(r?.hint?.trim()).toBeTruthy(); // DX4: a FAIL must be actionable — carry a repair hint
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

const CURRENT_MARKER =
    "// KNEXT_NODE_ENTRY_MARKER: 2\n/* rest of the template */";
const STALE_MARKER_1 =
    "// KNEXT_NODE_ENTRY_MARKER: 1\n/* rest of the app copy */";
const NO_MARKER = "/* pre-#1356 app copy, no marker line at all */";

describe("extractNodeEntryMarker", () => {
    it("reads the number out of the KNEXT_NODE_ENTRY_MARKER comment", () => {
        expect(extractNodeEntryMarker(CURRENT_MARKER)).toBe(2);
        expect(extractNodeEntryMarker(STALE_MARKER_1)).toBe(1);
    });

    it("returns undefined when there is no marker at all", () => {
        expect(extractNodeEntryMarker(NO_MARKER)).toBeUndefined();
    });

    it("returns undefined on a non-numeric or malformed marker (never throws, never guesses)", () => {
        expect(
            extractNodeEntryMarker("// KNEXT_NODE_ENTRY_MARKER: not-a-number"),
        ).toBeUndefined();
    });
});

/** The only config shape this check ever proceeds past skip for. */
const VINEXT_NODE_CONFIG = {
    build: "vinext",
    runtime: "node",
} as unknown as KnativeNextConfig;

describe("nodeEntryStalenessCheck (isolated, #1356)", () => {
    it("SKIP when kn-next.config.ts is not vinext + node (default-standalone: no build/runtime at all)", async () => {
        const [r] = await nodeEntryStalenessCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () =>
                        ({}) as unknown as KnativeNextConfig,
                    // If this ran, it would find a scaffolded (inert) copy and WARN —
                    // proving the config gate, not the file reader, is what skips it.
                    readNodeEntryFile: () => NO_MARKER,
                    readNodeEntryTemplate: () => CURRENT_MARKER,
                },
            ),
        );
        expect(r?.status).toBe("skip");
        expect(r?.id).toBe("node-entry-staleness");
        expect(r?.detail).toContain("vinext");
    });

    it("SKIP when kn-next.config.ts is build: 'vinext' but runtime is absent (defaults to bun, ADR-0058)", async () => {
        const [r] = await nodeEntryStalenessCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () =>
                        ({ build: "vinext" }) as unknown as KnativeNextConfig,
                    readNodeEntryFile: () => NO_MARKER,
                    readNodeEntryTemplate: () => CURRENT_MARKER,
                },
            ),
        );
        expect(r?.status).toBe("skip");
    });

    it("SKIP when no kn-next.config.ts could be loaded at all", async () => {
        const [r] = await nodeEntryStalenessCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () => undefined,
                    readNodeEntryFile: () => NO_MARKER,
                    readNodeEntryTemplate: () => CURRENT_MARKER,
                },
            ),
        );
        expect(r?.status).toBe("skip");
    });

    it("SKIP when the app directory has no knext-node-entry.mjs at all", async () => {
        const [r] = await nodeEntryStalenessCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () => VINEXT_NODE_CONFIG,
                    readNodeEntryFile: () => undefined,
                    readNodeEntryTemplate: () => CURRENT_MARKER,
                },
            ),
        );
        expect(r?.status).toBe("skip");
        expect(r?.id).toBe("node-entry-staleness");
    });

    it("SKIP when the packaged template itself carries no marker (defensive — never guess)", async () => {
        const [r] = await nodeEntryStalenessCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () => VINEXT_NODE_CONFIG,
                    readNodeEntryFile: () => CURRENT_MARKER,
                    readNodeEntryTemplate: () => NO_MARKER,
                },
            ),
        );
        expect(r?.status).toBe("skip");
    });

    it("PASS when the app's marker matches the packaged template's", async () => {
        const [r] = await nodeEntryStalenessCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () => VINEXT_NODE_CONFIG,
                    readNodeEntryFile: () => CURRENT_MARKER,
                    readNodeEntryTemplate: () => CURRENT_MARKER,
                },
            ),
        );
        expect(r?.status).toBe("pass");
        expect(r?.detail).toContain("marker 2");
    });

    it("WARN naming the exact fix when the app's marker is OLDER than the packaged template's", async () => {
        const [r] = await nodeEntryStalenessCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () => VINEXT_NODE_CONFIG,
                    readNodeEntryFile: () => STALE_MARKER_1,
                    readNodeEntryTemplate: () => CURRENT_MARKER,
                },
            ),
        );
        expect(r?.status).toBe("warn");
        expect(r?.detail).toContain("marker 1");
        expect(r?.detail).toContain("marker 2");
        expect(r?.detail).not.toContain("#1353");
        // The exact fix: copy the current entry.
        expect(r?.hint).toContain("knext create --force");
        expect(r?.hint).toContain("knext-node-entry.mjs");
    });

    it("WARN (never a silent pass) when the app's copy predates the marker entirely", async () => {
        const [r] = await nodeEntryStalenessCheck(
            makeCtx(
                {},
                {
                    loadAppConfig: async () => VINEXT_NODE_CONFIG,
                    readNodeEntryFile: () => NO_MARKER,
                    readNodeEntryTemplate: () => CURRENT_MARKER,
                },
            ),
        );
        expect(r?.status).toBe("warn");
        expect(r?.detail).toContain("no marker at all");
        expect(r?.hint).toBeTruthy();
    });

    it("uses the REAL cwd/config/template readers by default when no deps are injected (does not throw)", async () => {
        // No overrides at all — exercises the real fs-backed defaults. The
        // test cwd almost certainly has no kn-next.config.ts, so this should
        // SKIP, not throw or crash.
        const [r] = await nodeEntryStalenessCheck(makeCtx({}));
        expect(r?.id).toBe("node-entry-staleness");
        expect(["skip", "pass", "warn"]).toContain(r?.status);
    });

    it("the SHIPPED templates/app/knext-node-entry.mjs.hbs template has a marker this check can parse", () => {
        // Guards against the check silently degrading to a permanent SKIP: if
        // the marker comment is ever deleted from the real template,
        // defaultReadTemplateEntry's caller treats that as "packaged template
        // is incomplete" and skips forever rather than warning anyone. Read
        // the real shipped file directly (not through a mocked reader).
        const templatePath = join(
            HERE,
            "..",
            "..",
            "templates",
            "app",
            "knext-node-entry.mjs.hbs",
        );
        const text = readFileSync(templatePath, "utf8");
        expect(extractNodeEntryMarker(text)).toBeDefined();
    });

    it("the shipped template's header marker and its own startup-log marker agree", () => {
        // node-entry-staleness.ts diagnoses staleness from the header comment
        // (KNEXT_NODE_ENTRY_MARKER); the running process separately logs
        // NODE_ENTRY_MARKER:<n> at boot so a marker can be read from
        // `kubectl logs` alone, without shell access to the source tree
        // (see the template's own comment). The two are two independent
        // literals in the same file — assert they cannot drift apart.
        const templatePath = join(
            HERE,
            "..",
            "..",
            "templates",
            "app",
            "knext-node-entry.mjs.hbs",
        );
        const text = readFileSync(templatePath, "utf8");
        const headerMarker = extractNodeEntryMarker(text);
        const logLineMatch = /console\.log\('NODE_ENTRY_MARKER:(\d+)'\)/.exec(
            text,
        );
        expect(headerMarker).toBeDefined();
        expect(logLineMatch).not.toBeNull();
        expect(String(headerMarker)).toBe(logLineMatch?.[1] ?? "<no match>");
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
        expect(r?.hint?.trim()).toBeTruthy(); // DX4: a FAIL must be actionable — carry a repair hint
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
        expect(r?.hint?.trim()).toBeTruthy(); // DX4: an ERROR must be actionable — carry a repair hint
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
        expect(r?.hint?.trim()).toBeTruthy(); // DX4: a FAIL must be actionable — carry a repair hint
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
        expect(r?.hint?.trim()).toBeTruthy(); // DX4: a FAIL must be actionable — carry a repair hint
    });

    // B7 (#1238) gap-fill: the earlier pair only reaches PASS and the
    // kourier-class/no-reconciler FAIL. Five more branches were never hit:
    // both infra-error early-returns, the genuine configmap-absent FAIL, and
    // the two WARN outcomes for a non-kourier or mismatched ingress-class.
    it("ERROR when the config-network probe itself fails (network-classified stderr)", () => {
        const [r] = ingressCheck(
            makeCtx({
                [NET_KEY]: {
                    ok: false,
                    stderr: "connection refused",
                },
            }),
        );
        expect(r?.status).toBe("error");
        expect(r?.hint?.trim()).toBeTruthy();
    });

    it("FAIL when config-network genuinely does not exist (Knative Serving not installed)", () => {
        const [r] = ingressCheck(
            makeCtx({
                [NET_KEY]: {
                    ok: false,
                    stderr: 'Error from server (NotFound): "config-network" not found',
                },
            }),
        );
        expect(r?.status).toBe("fail");
        expect(r?.detail).toContain("is Knative Serving installed?");
    });

    it("ERROR when the kourier-reconciler probe itself fails on BOTH namespaces (network-classified)", () => {
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
                    stderr: "connection refused",
                },
                "kubectl get deployment net-kourier-controller -n kourier-system -o json":
                    {
                        ok: false,
                        stderr: "connection refused",
                    },
            }),
        );
        expect(r?.status).toBe("error");
        expect(r?.detail).toContain(
            "kourier-reconciler presence could not be verified",
        );
    });

    it("WARN when a Ready kourier reconciler exists but config-network points at a different class", () => {
        const [r] = ingressCheck(
            makeCtx({
                [NET_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        data: {
                            "ingress-class":
                                "istio.ingress.networking.knative.dev",
                        },
                    }),
                },
                [KOURIER_KEY]: {
                    ok: true,
                    stdout: singleDeployJson("net-kourier-controller"),
                },
            }),
        );
        expect(r?.status).toBe("warn");
        expect(r?.detail).toContain("silently skipped");
    });

    it("WARN when the class is non-kourier and no kourier reconciler was found at all", () => {
        const [r] = ingressCheck(
            makeCtx({
                [NET_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        data: {
                            "ingress-class":
                                "istio.ingress.networking.knative.dev",
                        },
                    }),
                },
                [KOURIER_KEY]: {
                    ok: false,
                    stderr: 'Error from server (NotFound): "x" not found',
                },
            }),
        );
        expect(r?.status).toBe("warn");
        expect(r?.detail).toContain("no net-kourier reconciler was found");
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
        expect(r?.hint?.trim()).toBeTruthy(); // DX4: a FAIL must be actionable — carry a repair hint
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
        expect(r?.hint?.trim()).toBeTruthy(); // DX4: a FAIL must be actionable — carry a repair hint
    });

    // B7 (#1238) gap-fill: real branches the earlier PASS/FAIL pair above
    // never exercised — the two infra-error paths, the legacy config key, the
    // "unknown protocol" fallback, and the two onUserMetrics outcomes.
    it("ERROR when the config-observability probe itself fails (network-classified stderr)", () => {
        const [r] = metricsCheck(
            makeCtx({
                [OBS_KEY]: {
                    ok: false,
                    stderr: "connection refused",
                },
            }),
        );
        expect(r?.status).toBe("error");
        expect(r?.hint?.trim()).toBeTruthy();
    });

    it("ERROR when the nextapps list probe itself fails (network-classified stderr)", () => {
        const [r] = metricsCheck(
            makeCtx({
                [OBS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        data: { "request-metrics-protocol": "none" },
                    }),
                },
                [NEXTAPPS_KEY]: {
                    ok: false,
                    stderr: "connection refused",
                },
            }),
        );
        expect(r?.status).toBe("error");
        expect(r?.detail).toContain(
            "METRICS_PORT overrides could not be verified",
        );
    });

    it("PASS-with-unknown-caveat when the configmap doesn't exist at all (NotFound, not infra)", () => {
        const [r] = metricsCheck(
            makeCtx({
                [OBS_KEY]: {
                    ok: false,
                    stderr: 'Error from server (NotFound): "x" not found',
                },
                [NEXTAPPS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({ items: [] }),
                },
            }),
        );
        expect(r?.status).toBe("pass");
        expect(r?.detail).toContain("config-observability not found");
    });

    it("honours the LEGACY backend-destination key, not just the modern protocol key", () => {
        const [r] = metricsCheck(
            makeCtx({
                [OBS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        data: {
                            "metrics.request-metrics-backend-destination":
                                "prometheus",
                        },
                    }),
                },
                [NEXTAPPS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        items: [
                            {
                                metadata: { name: "web", namespace: "demo" },
                                spec: { env: { METRICS_PORT: "9091" } },
                            },
                        ],
                    }),
                },
            }),
        );
        expect(r?.status).toBe("fail");
        expect(r?.detail).toContain("backend-destination");
    });

    it("WARN (not fail) when :9091 is pinned but the protocol cannot be determined", () => {
        const [r] = metricsCheck(
            makeCtx({
                [OBS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({ data: {} }),
                },
                [NEXTAPPS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        items: [
                            {
                                metadata: { name: "web", namespace: "demo" },
                                spec: { env: { METRICS_PORT: "9091" } },
                            },
                        ],
                    }),
                },
            }),
        );
        expect(r?.status).toBe("warn");
        expect(r?.detail).toContain("WILL");
    });

    it("PASS when the backend is an explicit non-prometheus value (neither none nor prometheus)", () => {
        const [r] = metricsCheck(
            makeCtx({
                [OBS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({
                        data: { "request-metrics-protocol": "opencensus" },
                    }),
                },
                [NEXTAPPS_KEY]: {
                    ok: true,
                    stdout: JSON.stringify({ items: [] }),
                },
            }),
        );
        expect(r?.status).toBe("pass");
        expect(r?.detail).toContain('backend is "opencensus"');
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
