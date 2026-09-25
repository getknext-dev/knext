/**
 * #978: every cluster-writing verb must honour an explicit `--context <ctx>`
 * and target THAT cluster, never the ambient kubectl current-context — else
 * `knext cleanup --context staging` silently deletes on production.
 *
 * This suite drives each verb's exec boundary with a capturing runner and a
 * resolved context, then asserts — as a SCAN over EVERY kubectl argv the verb
 * issued — that the context reached the argv. An omission (a kubectl call built
 * without the resolved context) fails here rather than slipping through.
 */

import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCleanup } from "../cli/cleanup";
import { runDbBind } from "../cli/db-bind";
import { runAssetGC } from "../cli/gc";
import { runLoadTest } from "../cli/loadtest";
import { runPreviewDeploy, runPreviewDestroy } from "../cli/preview";
import { runRollback } from "../cli/rollback";
import { resolveKubeContext, withKubeContext } from "../cli/shared";
import {
    parseStatusArgs,
    runStatus,
    type StatusDeps,
    type StatusOptions,
} from "../cli/status";
import type { KnativeNextConfig } from "../config";

const CTX = "staging-cluster";

const baseConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "my-bucket",
        publicUrl: "https://storage.googleapis.com/my-bucket",
    },
    cache: {
        provider: "redis",
        url: "redis://redis:6379",
        keyPrefix: "my-app",
    },
};

/** Assert a captured kubectl argv carries exactly one `--context <ctx>`. */
function expectContext(argv: string[], ctx: string): void {
    expect(argv[0]).toBe("kubectl");
    const idx = argv.indexOf("--context");
    expect(idx, `argv missing --context: ${argv.join(" ")}`).toBeGreaterThan(0);
    expect(argv[idx + 1]).toBe(ctx);
    expect(argv.filter((a) => a === "--context")).toHaveLength(1);
}

describe("withKubeContext (#978 helper)", () => {
    it("inserts --context immediately after the kubectl binary token", () => {
        expect(
            withKubeContext(["kubectl", "delete", "nextapp", "x"], CTX),
        ).toEqual(["kubectl", "--context", CTX, "delete", "nextapp", "x"]);
    });

    it("is a no-op (fresh copy) when no context is provided — ambient default", () => {
        const argv = ["kubectl", "get", "nextapp", "x"];
        expect(withKubeContext(argv)).toEqual(argv);
        expect(withKubeContext(argv, "")).toEqual(argv);
        expect(withKubeContext(argv)).not.toBe(argv);
    });

    it("resolveKubeContext: flag wins, else KN_CONTEXT, else undefined", () => {
        const saved = process.env.KN_CONTEXT;
        try {
            process.env.KN_CONTEXT = "env-ctx";
            expect(resolveKubeContext("flag-ctx")).toBe("flag-ctx");
            expect(resolveKubeContext(undefined)).toBe("env-ctx");
            delete process.env.KN_CONTEXT;
            expect(resolveKubeContext(undefined)).toBeUndefined();
        } finally {
            if (saved === undefined) delete process.env.KN_CONTEXT;
            else process.env.KN_CONTEXT = saved;
        }
    });
});

describe("cleanup honours --context (#978 acceptance)", () => {
    it("passes --context to the kubectl delete argv", () => {
        const exec = mock();
        runCleanup(baseConfig, exec, CTX);
        expect(exec).toHaveBeenCalledTimes(1);
        expectContext(exec.mock.calls[0][0] as string[], CTX);
    });

    it("issues NO --context when none is resolved (ambient current-context)", () => {
        const exec = mock();
        runCleanup(baseConfig, exec);
        const argv = exec.mock.calls[0][0] as string[];
        expect(argv).not.toContain("--context");
    });
});

describe("rollback honours --context (#978)", () => {
    it("every kubectl argv carries --context", () => {
        const exec = mock();
        runRollback("my-app", "default", "my-app-00002", undefined, exec, CTX);
        for (const call of exec.mock.calls) {
            expectContext(call[0] as string[], CTX);
        }
        expect(exec.mock.calls.length).toBeGreaterThan(0);
    });
});

describe("db bind honours --context (#978)", () => {
    it("every kubectl argv (reads + patch) carries --context", async () => {
        const captured: string[][] = [];
        const exec = mock((argv: readonly string[]) => {
            captured.push([...argv]);
            // Answer the read-back probes with a CR that already has the bind so
            // the silent-prune guard passes without a real cluster.
            return JSON.stringify({
                spec: { database: { secretRef: { name: "app-db" } } },
            });
        });
        await runDbBind(
            "my-app",
            {
                app: "my-app",
                namespace: "default",
                secret: "app-db",
                dryRun: false,
                context: CTX,
            },
            { exec, write: () => {} },
        );
        const kubectlCalls = captured.filter((a) => a[0] === "kubectl");
        expect(kubectlCalls.length).toBeGreaterThan(0);
        for (const argv of kubectlCalls) {
            expectContext(argv, CTX);
        }
    });
});

describe("gc honours --context (#978)", () => {
    it("every kubectl read argv carries --context", () => {
        const captured: string[][] = [];
        const exec = mock((argv: readonly string[]) => {
            captured.push([...argv]);
            // Non-empty currentTraffic + a resolvable pin so the plan proceeds
            // through the per-revision label reads (more argv to scan).
            const a = argv.join(" ");
            if (a.includes("status.currentTraffic")) return "'my-app-00002'";
            if (a.includes("spec.traffic.revisionName")) return "''";
            return "'build-2'";
        });
        runAssetGC(
            baseConfig as never,
            "default",
            "build-3",
            exec,
            // prune stub — asset deletion is not under test here.
            (() => ({ kept: [], reaped: [] })) as never,
            true,
            CTX,
        );
        const kubectlCalls = captured.filter((a) => a[0] === "kubectl");
        expect(kubectlCalls.length).toBeGreaterThan(0);
        for (const argv of kubectlCalls) {
            expectContext(argv, CTX);
        }
    });
});

describe("preview honours --context (#978)", () => {
    it("deploy: the apply + status-read argv carry --context", async () => {
        const captured: string[][] = [];
        const apply = mock((argv: readonly string[]) => {
            captured.push([...argv]);
        });
        const capture = mock((argv: readonly string[]) => {
            captured.push([...argv]);
            return "https://my-app-pr-7.example.com";
        });
        await runPreviewDeploy(
            baseConfig,
            {
                prId: "7",
                branch: "feat/x",
                namespace: "previews",
                context: CTX,
            },
            {
                apply,
                capture,
                buildAndPush: async () =>
                    `registry.example.com/my-app-pr-7:t@sha256:${"a".repeat(64)}`,
                // Bind context in so the preflight sees it too; assert on it.
                preflight: (_crPath, _ns, ctx) => {
                    expect(ctx).toBe(CTX);
                },
            },
        );
        const kubectlCalls = captured.filter((a) => a[0] === "kubectl");
        expect(kubectlCalls.length).toBeGreaterThan(0);
        for (const argv of kubectlCalls) {
            expectContext(argv, CTX);
        }
    });

    it("destroy: the delete argv carries --context", () => {
        const exec = mock();
        runPreviewDestroy(
            baseConfig,
            { prId: "7", namespace: "previews", context: CTX },
            exec,
        );
        expectContext(exec.mock.calls[0][0] as string[], CTX);
    });
});

describe("status honours --context (#978, read-side)", () => {
    const deps = (kubectl: StatusDeps["kubectl"]): StatusDeps => ({
        kubectl,
        write: () => {},
        now: () => new Date(0),
        sleep: async () => {},
    });
    const opts = (context?: string): StatusOptions => ({
        namespace: "default",
        json: true,
        watch: false,
        timeoutMs: 1000,
        context,
    });

    it("the `kubectl get nextapp` read argv carries --context", async () => {
        const captured: string[][] = [];
        const kubectl = mock((argv: readonly string[]) => {
            captured.push([...argv]);
            return { ok: true, stdout: "{}", stderr: "" };
        });
        await runStatus("my-app", opts(CTX), deps(kubectl));
        const kubectlCalls = captured.filter((a) => a[0] === "kubectl");
        expect(kubectlCalls.length).toBeGreaterThan(0);
        for (const argv of kubectlCalls) {
            expectContext(argv, CTX);
        }
    });

    it("issues NO --context when none is resolved (ambient current-context)", async () => {
        const captured: string[][] = [];
        const kubectl = mock((argv: readonly string[]) => {
            captured.push([...argv]);
            return { ok: true, stdout: "{}", stderr: "" };
        });
        await runStatus("my-app", opts(undefined), deps(kubectl));
        expect(captured[0]).not.toContain("--context");
    });

    it("parseStatusArgs reads --context and --context=<v>", () => {
        expect(parseStatusArgs(["--context", CTX]).context).toBe(CTX);
        expect(parseStatusArgs([`--context=${CTX}`]).context).toBe(CTX);
        expect(parseStatusArgs([]).context).toBeUndefined();
    });
});

describe("loadtest honours --context (#978, apply-side)", () => {
    it("the k6-Job `kubectl apply` argv carries --context", async () => {
        const savedCwd = process.cwd();
        const dir = mkdtempSync(join(tmpdir(), "knext-loadtest-ctx-"));
        process.chdir(dir);
        try {
            const captured: string[][] = [];
            const exec = mock((argv: readonly string[]) => {
                captured.push([...argv]);
            });
            await runLoadTest(
                "my-app",
                "https://app.example.com",
                "smoke",
                "default",
                false,
                CTX,
                exec,
            );
            const kubectlCalls = captured.filter((a) => a[0] === "kubectl");
            expect(kubectlCalls.length).toBeGreaterThan(0);
            for (const argv of kubectlCalls) {
                expectContext(argv, CTX);
            }
        } finally {
            process.chdir(savedCwd);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("issues NO --context when none is resolved (ambient current-context)", async () => {
        const savedCwd = process.cwd();
        const dir = mkdtempSync(join(tmpdir(), "knext-loadtest-noctx-"));
        process.chdir(dir);
        try {
            const captured: string[][] = [];
            const exec = mock((argv: readonly string[]) => {
                captured.push([...argv]);
            });
            await runLoadTest(
                "my-app",
                "https://app.example.com",
                "smoke",
                "default",
                false,
                undefined,
                exec,
            );
            expect(captured[0]).not.toContain("--context");
        } finally {
            process.chdir(savedCwd);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
