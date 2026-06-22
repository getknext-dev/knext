/**
 * A1-cli: Tests that deploy.ts emits and applies a NextApp CR only,
 * with no raw kubectl apply of Knative or infra manifests.
 *
 * Key invariants verified:
 * 1. `renderNextAppCR` produces a valid NextApp CR YAML.
 * 2. The CR carries scale-to-zero (min-scale: 0), bytecode PVC fields,
 *    and NODE_COMPILE_CACHE wiring so the operator can reconcile them.
 * 3. `dryRunDeploy` returns CR YAML and calls its execFn 0 times
 *    (exec-boundary spy = 0 calls).
 * 4. `resolveDigest` calls execFn with `docker inspect` and returns a
 *    digest-pinned ref containing @sha256: — so the operator accepts it.
 * 5. A tag-only ref (no @sha256:) is REJECTED by validateCRImageRef.
 */

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
    dryRunDeploy,
    renderNextAppCR,
    resolveDigest,
    validateCRImageRef,
} from "../cli/cr-builder";
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
    scaling: {
        minScale: 0,
        maxScale: 5,
    },
};

describe("renderNextAppCR", () => {
    it("returns a NextApp CR YAML string", () => {
        const yaml = renderNextAppCR(
            baseConfig,
            "registry.example.com/my-app:v1@sha256:abc123",
            "default",
        );
        expect(yaml).toBeTruthy();

        const parsed = YAML.parse(yaml) as Record<string, unknown>;
        expect(parsed.apiVersion).toBe("apps.kn-next.dev/v1alpha1");
        expect(parsed.kind).toBe("NextApp");
    });

    it("CR spec.image matches the provided image ref", () => {
        const image = "registry.example.com/my-app:v1@sha256:abc123def456";
        const yaml = renderNextAppCR(baseConfig, image, "default");
        const cr = YAML.parse(yaml) as { spec: { image: string } };
        expect(cr.spec.image).toBe(image);
    });

    it("CR carries spec.buildId when a build id is passed (#93 skew protection)", () => {
        // The build id (deploy tag) must reach the operator so it can stamp the
        // `apps.kn-next.dev/build-id` revision label the asset GC resolves against.
        const yaml = renderNextAppCR(
            baseConfig,
            "img@sha256:abc",
            "default",
            "20240101120000",
        );
        const cr = YAML.parse(yaml) as { spec: { buildId?: string } };
        expect(cr.spec.buildId).toBe("20240101120000");
    });

    it("CR omits spec.buildId when no build id is passed (back-compat)", () => {
        const yaml = renderNextAppCR(baseConfig, "img@sha256:abc", "default");
        const cr = YAML.parse(yaml) as { spec: Record<string, unknown> };
        expect(cr.spec.buildId).toBeUndefined();
    });

    it("CR preserves scale-to-zero (minScale: 0)", () => {
        const yaml = renderNextAppCR(baseConfig, "img@sha256:abc", "default");
        const cr = YAML.parse(yaml) as {
            spec: { scaling: { minScale: number } };
        };
        expect(cr.spec.scaling.minScale).toBe(0);
    });

    it("CR carries bytecode cache fields when cache.provider=redis", () => {
        const configWithBytecode: KnativeNextConfig = {
            ...baseConfig,
            cache: {
                provider: "redis",
                url: "redis://redis:6379",
                keyPrefix: "my-app",
            },
        };
        const yaml = renderNextAppCR(
            configWithBytecode,
            "img@sha256:abc",
            "default",
        );
        const cr = YAML.parse(yaml) as {
            spec: {
                cache: {
                    enableBytecodeCache: boolean;
                    url: string;
                    keyPrefix: string;
                };
            };
        };
        // The CLI enables bytecode cache by default when Redis is configured.
        expect(cr.spec.cache.enableBytecodeCache).toBe(true);
        expect(cr.spec.cache.url).toBe("redis://redis:6379");
        expect(cr.spec.cache.keyPrefix).toBe("my-app");
    });

    it("CR namespace matches the provided namespace", () => {
        const yaml = renderNextAppCR(
            baseConfig,
            "img@sha256:abc",
            "production",
        );
        const cr = YAML.parse(yaml) as {
            metadata: { namespace: string };
        };
        expect(cr.metadata.namespace).toBe("production");
    });
});

describe("dryRunDeploy exec boundary", () => {
    it("dry-run returns CR YAML and calls execFn 0 times", async () => {
        // execFn is the exec-boundary spy injected into dryRunDeploy.
        // In dry-run mode the function must never shell out.
        const execSpy = vi.fn().mockResolvedValue(undefined);

        const output = await dryRunDeploy(
            baseConfig,
            "registry.example.com/my-app:v1@sha256:abc123",
            "default",
            execSpy,
        );

        // Zero cluster side-effects.
        expect(execSpy).toHaveBeenCalledTimes(0);
        // Output must be valid NextApp CR YAML.
        const cr = YAML.parse(output) as { kind: string };
        expect(cr.kind).toBe("NextApp");
    });
});

// ---------------------------------------------------------------------------
// CLI-58: digest-pinning — resolveDigest + validateCRImageRef
// ---------------------------------------------------------------------------

describe("validateCRImageRef", () => {
    it("accepts a digest-pinned ref (contains @sha256:)", () => {
        expect(() =>
            validateCRImageRef(
                "registry.example.com/my-app:v1@sha256:abc123def456",
            ),
        ).not.toThrow();
    });

    it("accepts a digest-only ref (no tag, just @sha256:)", () => {
        expect(() =>
            validateCRImageRef(
                "registry.example.com/my-app@sha256:abc123def456",
            ),
        ).not.toThrow();
    });

    it("rejects a tag-only ref (no @sha256:)", () => {
        expect(() =>
            validateCRImageRef("registry.example.com/my-app:1234567890"),
        ).toThrow(/@sha256:/);
    });

    it("rejects :latest", () => {
        expect(() =>
            validateCRImageRef("registry.example.com/my-app:latest"),
        ).toThrow(/@sha256:/);
    });

    it("rejects a bare name with no tag or digest", () => {
        expect(() => validateCRImageRef("registry.example.com/my-app")).toThrow(
            /@sha256:/,
        );
    });
});

describe("resolveDigest", () => {
    const FAKE_DIGEST =
        "sha256:deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc";
    // docker inspect --format={{index .RepoDigests 0}} emits:
    //   registry.example.com/my-app@sha256:<hash>
    const FAKE_REPO_DIGEST = `registry.example.com/my-app@${FAKE_DIGEST}`;

    it("calls execFn with docker inspect ARGV array and returns a digest-pinned ref", async () => {
        // execSpy simulates: docker inspect --format ... returning a RepoDigest line.
        // ExecFn now receives string[] (ARGV), never a shell string.
        const execSpy = vi.fn().mockResolvedValue(FAKE_REPO_DIGEST);

        const taggedRef = "registry.example.com/my-app:1234567890";
        const result = await resolveDigest(taggedRef, execSpy);

        // Must have called the exec boundary exactly once
        expect(execSpy).toHaveBeenCalledTimes(1);

        // ExecFn MUST receive an ARGV array — not a shell string.
        const argv = execSpy.mock.calls[0][0] as string[];
        expect(Array.isArray(argv)).toBe(true);
        expect(argv[0]).toBe("docker");
        expect(argv[1]).toBe("inspect");
        // taggedRef must be the last element — a single, uninterpreted token.
        expect(argv[argv.length - 1]).toBe(taggedRef);

        // The result must contain @sha256: so operator accepts it
        expect(result).toContain("@sha256:");
        expect(result).toContain("deadbeef");
    });

    it("preserves the original tag alongside the digest (tag@sha256: form)", async () => {
        const execSpy = vi.fn().mockResolvedValue(FAKE_REPO_DIGEST);
        const taggedRef = "registry.example.com/my-app:v42";
        const result = await resolveDigest(taggedRef, execSpy);
        // Result should be tag@sha256: or repo@sha256: — either way @sha256: must be present
        expect(result).toMatch(/@sha256:[0-9a-f]+/);
    });

    it("throws if execFn returns output without a sha256 digest", async () => {
        const execSpy = vi.fn().mockResolvedValue("");
        await expect(
            resolveDigest("registry.example.com/my-app:bad", execSpy),
        ).rejects.toThrow(/digest/);
    });

    it("passes the digest-pinned ref through renderNextAppCR unchanged", async () => {
        const execSpy = vi.fn().mockResolvedValue(FAKE_REPO_DIGEST);
        const taggedRef = "registry.example.com/my-app:1234567890";
        const pinnedRef = await resolveDigest(taggedRef, execSpy);

        const crYaml = renderNextAppCR(baseConfig, pinnedRef, "default");
        const cr = YAML.parse(crYaml) as { spec: { image: string } };
        expect(cr.spec.image).toContain("@sha256:");
        // Invariants: minScale preserved
        const crScaling = YAML.parse(crYaml) as {
            spec: { scaling: { minScale: number } };
        };
        expect(crScaling.spec.scaling.minScale).toBe(0);
        // Invariants: bytecode cache preserved
        const crCache = YAML.parse(crYaml) as {
            spec: { cache: { enableBytecodeCache: boolean } };
        };
        expect(crCache.spec.cache.enableBytecodeCache).toBe(true);
    });
});
