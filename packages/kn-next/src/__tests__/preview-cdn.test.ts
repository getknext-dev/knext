/**
 * A per-PR preview is its own app (`<app>-pr-<n>`) on its own host, not behind
 * the production CDN. The production `cdn` block must NOT ride along: a preview
 * would otherwise edge-cache and send purge calls against the production zone
 * with the production credential. Dropped, the preview behaves exactly as an
 * app without `spec.cdn`.
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

const config: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "b",
        publicUrl: "https://example.com",
    },
    cdn: {
        provider: "cloudflare",
        purge: {
            secretRef: { name: "cdn-purge", key: "token" },
            target: "0123456789abcdef0123456789abcdef",
        },
    },
};

function readCr(file: string): { spec: Record<string, unknown> } {
    return YAML.parse(
        readFileSync(join(process.cwd(), ".output", file), "utf-8"),
    ) as { spec: Record<string, unknown> };
}

beforeEach(() => {
    jest.clearAllMocks();
    captureKubectl.mockImplementation(() => ({
        ok: true,
        stdout: "",
        stderr: "",
    }));
});

describe("runPreviewDeploy does not carry the production cdn block", () => {
    it("writes no spec.cdn to the preview CR or the prune-preflight CR", async () => {
        await runPreviewDeploy(
            config,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            {
                apply: mock((_argv: readonly string[]) => {}),
                capture: mock((_argv: readonly string[]) => "https://x"),
                buildAndPush: mock(async (_name: string) => digestImage),
                visibilityGuard: async () => {},
            },
        );
        for (const file of [
            "nextapp-preview-cr.yaml",
            "nextapp-preview-preflight-cr.yaml",
        ]) {
            expect(readCr(file).spec).not.toHaveProperty("cdn");
        }
    });
});
