/**
 * Issue #74: teardown consolidation.
 *
 * ADR-0001 — the operator is the single authority for cluster state. The CLI
 * teardown must emit INTENT, not mutate the cluster: `cleanup.ts` issues ONLY a
 * `kubectl delete nextapp <name>` (mirroring how `deploy.ts` applies only the
 * CR). The operator's external-cleanup finalizer is now the single teardown
 * authority — the CLI must NOT delete ksvc/SA/PVC/statefulset/svc directly, and
 * must NOT shell out to any storage CLI (gsutil/aws/mc/az) to clear buckets.
 */

import { describe, expect, it, vi } from "vitest";
import { runCleanup } from "../cli/cleanup";
import type { KnativeNextConfig } from "../config";

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

describe("runCleanup (#74 — CR-only teardown)", () => {
    it("issues exactly one command: kubectl delete nextapp <name>", () => {
        const exec = vi.fn();
        runCleanup(baseConfig, exec);

        expect(exec).toHaveBeenCalledTimes(1);
        const argv = exec.mock.calls[0][0] as string[];
        expect(argv[0]).toBe("kubectl");
        expect(argv[1]).toBe("delete");
        expect(argv[2]).toBe("nextapp");
        expect(argv).toContain("my-app");
    });

    it("passes the app name as a single uninterpreted argv token (no shell)", () => {
        const exec = vi.fn();
        runCleanup({ ...baseConfig, name: "my-app" }, exec);
        const argv = exec.mock.calls[0][0] as string[];
        expect(Array.isArray(argv)).toBe(true);
        expect(argv).toContain("my-app");
    });

    it("NEVER deletes ksvc / SA / PVC / statefulset / svc directly (ownerRef GC owns those)", () => {
        const exec = vi.fn();
        runCleanup(baseConfig, exec);
        const forbidden = [
            "ksvc",
            "service",
            "serviceaccount",
            "sa",
            "pvc",
            "persistentvolumeclaim",
            "statefulset",
            "deployment",
            "svc",
        ];
        for (const call of exec.mock.calls) {
            const argv = call[0] as string[];
            for (const f of forbidden) {
                expect(argv).not.toContain(f);
            }
        }
    });

    it("NEVER shells out to a storage CLI (gsutil/aws/mc/az) — the operator finalizer clears storage", () => {
        const exec = vi.fn();
        runCleanup(
            {
                ...baseConfig,
                infrastructure: {
                    redis: { enabled: true },
                    postgres: { enabled: true },
                    minio: { enabled: true },
                } as KnativeNextConfig["infrastructure"],
            },
            exec,
        );
        const storageBins = ["gsutil", "aws", "mc", "az"];
        for (const call of exec.mock.calls) {
            const argv = call[0] as string[];
            expect(storageBins).not.toContain(argv[0]);
        }
        // Still only the single CR delete.
        expect(exec).toHaveBeenCalledTimes(1);
    });
});
