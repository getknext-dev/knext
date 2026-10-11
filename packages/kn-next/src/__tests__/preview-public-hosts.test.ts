/**
 * A per-PR preview is its own app (`<app>-pr-<n>`) on its own host. The
 * production `networking.publicHosts` list must NOT ride along: a preview's
 * redirect that carries the pod's wildcard bind address falls back to the
 * FIRST allowlisted host, so a copied list would send a reviewer following a
 * redirect on a preview to PRODUCTION. Dropping the list leaves the preview on
 * the runtime's unchanged behaviour (no allowlist, no rewrite).
 *
 * Both CRs a preview writes are checked: the one applied and the one the
 * prune preflight dry-runs.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { KnativeNextConfig } from "../config";

// biome-ignore lint/suspicious/noExplicitAny: mock return type only
type AnyFn = (...args: unknown[]) => any;

const captureKubectl = mock<AnyFn>(() => ({
    ok: true,
    stdout: "",
    stderr: "",
}));
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: (...a: unknown[]) => captureKubectl(...a),
}));

// Dynamic import, after mock.module registers (see preview-default-seams).
const { runPreviewDeploy } = await import("../cli/preview");

const digestImage =
    "registry.example.com/my-app-pr-42:123@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

function config(
    networking: KnativeNextConfig["networking"],
): KnativeNextConfig {
    return {
        name: "my-app",
        registry: "registry.example.com",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://example.com",
        },
        networking,
    };
}

function readCr(file: string): { spec: Record<string, unknown> } {
    return YAML.parse(
        readFileSync(join(process.cwd(), ".output", file), "utf-8"),
    ) as { spec: Record<string, unknown> };
}

async function deployPreview(cfg: KnativeNextConfig): Promise<void> {
    await runPreviewDeploy(
        cfg,
        { prId: "42", branch: "feat/x", namespace: "previews" },
        {
            apply: mock((_argv: readonly string[]) => {}),
            capture: mock((_argv: readonly string[]) => "https://x"),
            buildAndPush: mock(async (_name: string) => digestImage),
            visibilityGuard: async () => {},
        },
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    captureKubectl.mockImplementation(() => ({
        ok: true,
        stdout: "",
        stderr: "",
    }));
});

describe("runPreviewDeploy does not carry production publicHosts", () => {
    it("emits no spec.networking at all when publicHosts was the only networking key", async () => {
        await deployPreview(
            config({ publicHosts: ["www.example.com", "app.example.org"] }),
        );
        for (const file of [
            "nextapp-preview-cr.yaml",
            "nextapp-preview-preflight-cr.yaml",
        ]) {
            expect(readCr(file).spec).not.toHaveProperty("networking");
        }
    });

    it("keeps a cluster-local visibility but drops the hosts", async () => {
        await deployPreview(
            config({
                visibility: "cluster-local",
                publicHosts: ["www.example.com"],
            }),
        );
        for (const file of [
            "nextapp-preview-cr.yaml",
            "nextapp-preview-preflight-cr.yaml",
        ]) {
            expect(readCr(file).spec.networking).toEqual({
                visibility: "cluster-local",
            });
        }
    });
});
